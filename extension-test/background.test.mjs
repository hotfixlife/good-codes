// Replays browsing situations against the real background.js with a fake `chrome` and `fetch`.
//   node --test mvp/extension-test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---- fake chrome ----
const listeners = {};
const on = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
const fire = async (name, ...args) => { for (const fn of listeners[name] || []) await fn(...args); };
const area = () => {
  let data = {};
  return {
    get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, structuredClone(data[x])])),
    set: async (o) => { Object.assign(data, structuredClone(o)); },
    remove: async (k) => { for (const x of [].concat(k)) delete data[x]; },
    _reset: () => { data = {}; },
  };
};
const state = { granted: true, notificationsGranted: true, injected: [], notifications: [], reports: [], codes: [] };
const local = area(), session = area();

globalThis.chrome = {
  runtime: { onInstalled: on("installed"), onStartup: on("startup"), onMessage: on("message"), getURL: (p) => "ext://" + p },
  alarms: { create() {}, onAlarm: on("alarm") },
  storage: { local, session },
  permissions: {
    contains: async (q) => (q.permissions ? state.notificationsGranted : state.granted),
  },
  tabs: { onUpdated: on("updated"), onRemoved: on("removed"), create() {} },
  scripting: {
    executeScript: async ({ target, files, func, args }) => { if (func) state.injected.push({ tabId: target.tabId, ...args[0] }); },
  },
  notifications: {
    create: (id, opts) => state.notifications.push({ id, ...opts }),
    clear() {},
    onButtonClicked: on("notifButton"),
  },
  declarativeContent: { onPageChanged: { removeRules: (_, cb) => cb(), addRules: (_, cb) => cb() },
    PageStateMatcher: class {}, SetIcon: class {} },
};
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === "/api/codes") return { json: async () => ({ codes: state.codes }) };
  if (u.pathname === "/api/report") { state.reports.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; }
  return { json: async () => ({}) };
};
let now = 1_000_000;
Date.now = () => now;

// Load the source from a temp copy, with the build's server-address placeholder filled in.
const dir = mkdtempSync(join(tmpdir(), "gc-bg-"));
cpSync(new URL("../extension", import.meta.url), dir, { recursive: true });
const apiFile = join(dir, "api.js");
writeFileSync(apiFile, readFileSync(apiFile, "utf8").replace("__API__", "https://api.test"));
await import(pathToFileURL(join(dir, "background.js")).href);

const SHOP = "shop.com";
const sendMessage = (msg, tab) => new Promise((r) => fire("message", msg, { tab }, r));
const update = (tabId, info, url, status = info.status || "complete") => fire("updated", tabId, info, { id: tabId, url, status });
const settle = () => new Promise((r) => setTimeout(r, 20)); // handlers run through a queue
const asks = () => state.injected.filter((x) => x.mode === "ask");
const copy = async (tabId, url, code = "SAVE15") => { await sendMessage({ type: "copied", domain: SHOP, code }, { id: tabId, url }); await settle(); };

beforeEach(async () => {
  local._reset(); session._reset();
  await local.set({ domains: [SHOP] });
  Object.assign(state, { granted: true, notificationsGranted: true, injected: [], notifications: [], reports: [],
    codes: [
      { code: "SAVE15", status: "verified", description: "15% off", source: "submitted" },
      { code: "SHOP10", status: "unverified", description: "From the shop", source: "seed" },
      { code: "JUNK1", status: "unverified", source: "submitted" },
      { code: "OLD", status: "failing", source: "seed" }] });
  now = 1_000_000;
});

test("alerts off: nothing is shown or fetched", async () => {
  state.granted = false;
  await update(1, { status: "complete" }, "https://www.shop.com/cart"); await settle();
  assert.equal(state.injected.length, 0);
});

test("banner on a shop's cart page, once per tab, with only confirmed or shop-published codes", async () => {
  await update(1, { status: "complete" }, "https://www.shop.com/cart"); await settle();
  await update(1, { status: "complete" }, "https://www.shop.com/checkouts/abc"); await settle();
  assert.equal(state.injected.length, 1);
  assert.deepEqual(state.injected[0].codes.map((c) => c.code), ["SAVE15", "SHOP10"]);
});

test("no banner on a shop's other pages, or on other sites", async () => {
  await update(1, { status: "complete" }, "https://shop.com/"); await settle();
  await update(1, { status: "complete" }, "https://shop.com/products/socks"); await settle();
  await update(2, { status: "complete" }, "https://news.example.com/cart"); await settle();
  await update(3, { status: "complete" }, "https://notshop.com/cart"); await settle();
  assert.equal(state.injected.length, 0);
});

test("closing the banner hides it on that shop for 12 hours", async () => {
  await sendMessage({ type: "dismiss", domain: SHOP }, { id: 1 }); await settle();
  await update(2, { status: "complete" }, "https://shop.com/cart"); await settle();
  assert.equal(state.injected.length, 0);
  now += 13 * 3600 * 1000;
  await update(3, { status: "complete" }, "https://shop.com/cart"); await settle();
  assert.equal(state.injected.length, 1);
});

test("copied code: no question while moving through checkout, asked on the order confirmation page", async () => {
  await copy(1, "https://shop.com/checkouts/abc/information?token=secret");
  await update(1, { url: "https://shop.com/checkouts/abc/shipping" }, "https://shop.com/checkouts/abc/shipping"); await settle();
  await update(1, { status: "complete" }, "https://shop.com/checkouts/abc/payment"); await settle();
  assert.equal(asks().length, 0);
  await update(1, { status: "complete" }, "https://shop.com/checkouts/abc/thank_you"); await settle();
  assert.deepEqual(asks().map((a) => a.code), ["SAVE15"]);
});

test("only the page path is stored, never the query string", async () => {
  await copy(1, "https://shop.com/checkouts/abc?token=secret");
  const { pendings } = await local.get("pendings");
  assert.equal(JSON.stringify(pendings).includes("secret"), false);
});

test("going to a payment provider isn't leaving the shop", async () => {
  await copy(1, "https://shop.com/checkout");
  await update(1, { url: "https://www.paypal.com/checkoutnow" }, "https://www.paypal.com/checkoutnow", "loading"); await settle();
  assert.equal(state.notifications.length, 0);
  await update(1, { status: "complete" }, "https://shop.com/order-confirmation/123"); await settle();
  assert.equal(asks().length, 1);
});

test("leaving the shop before answering asks with a notification; its buttons vote", async () => {
  await copy(1, "https://shop.com/checkout");
  await update(1, { url: "https://www.google.com/" }, "https://www.google.com/", "loading"); await settle();
  assert.equal(state.notifications.length, 1);
  assert.match(state.notifications[0].title, /SAVE15/);
  await fire("notifButton", state.notifications[0].id, 1); await settle(); // "No"
  assert.deepEqual(state.reports.map((r) => [r.code, r.outcome]), [["SAVE15", "failed"]]);
});

test("closing the tab before answering asks with a notification", async () => {
  await copy(7, "https://shop.com/checkout");
  await fire("removed", 7); await settle();
  assert.equal(state.notifications.length, 1);
});

test("each tab has its own question", async () => {
  await copy(1, "https://shop.com/checkout", "SAVE15");
  await copy(2, "https://shop.com/checkout", "SHOP10");
  await update(1, { status: "complete" }, "https://shop.com/thank-you"); await settle();
  await update(2, { status: "complete" }, "https://shop.com/thank-you"); await settle();
  assert.deepEqual(asks().map((a) => a.code).sort(), ["SAVE15", "SHOP10"]);
});

test("answering in the banner sends the vote and stops asking", async () => {
  await copy(1, "https://shop.com/checkout");
  await sendMessage({ type: "vote", domain: SHOP, code: "SAVE15", outcome: "worked" }, { id: 1 }); await settle();
  assert.deepEqual(state.reports.map((r) => [r.code, r.outcome]), [["SAVE15", "worked"]]);
  await update(1, { status: "complete" }, "https://shop.com/thank-you"); await settle();
  assert.equal(asks().length, 0);
});

test("questions expire after a day, and a browser restart clears them", async () => {
  await copy(1, "https://shop.com/checkout");
  now += 25 * 3600 * 1000;
  await update(1, { status: "complete" }, "https://shop.com/thank-you"); await settle();
  assert.equal(asks().length, 0);
  await copy(2, "https://shop.com/checkout");
  await fire("startup"); await settle();
  await fire("removed", 2); await settle();
  assert.equal(state.notifications.length, 0);
});

test("no notification permission: leaving quietly drops the alert question (the popup still asks)", async () => {
  state.notificationsGranted = false;
  await copy(7, "https://shop.com/checkout");
  await fire("removed", 7); await settle();
  assert.equal(state.notifications.length, 0);
  const { lastCopy } = await local.get("lastCopy");
  assert.equal(lastCopy[SHOP].code, "SAVE15");
});

test("malformed messages are ignored", async () => {
  await sendMessage({ type: "vote", domain: "evil site", code: "X Y", outcome: "worked" }, { id: 1 });
  await sendMessage({ type: "vote", domain: SHOP, code: "SAVE15", outcome: "maybe" }, { id: 1 });
  await settle();
  assert.equal(state.reports.length, 0);
});
