import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as core from "../src/core.js";

const NOW = 1_800_000_000;
const DAY = core.DAY;
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

let db;
const wrap = (d) => ({
  all: async (sql, ...p) => d.prepare(sql).all(...p),
  first: async (sql, ...p) => d.prepare(sql).get(...p) ?? null,
  run: async (sql, ...p) => d.prepare(sql).run(...p),
});

beforeEach(async () => {
  core.config.allowLocalhost = false;
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  db = wrap(raw);
  await core.addCode(db, { domain: "shop.com", code: "SAVE10", description: "10% off", source: "seed" }, NOW);
});

// Each voter gets their own network unless told otherwise.
let n = 0;
const vote = (outcome, { client = `client-${++n}`, net = `net-${n}`, ago = 0, code = "SAVE10", domain = "shop.com" } = {}) =>
  core.addReport(db, { domain, code, outcome, client_id: client }, NOW - ago, { net });
const status = async (code = "SAVE10", domain = "shop.com") =>
  (await core.listCodes(db, domain, NOW)).find((c) => c.code === code);

test("new code is unverified", async () => {
  assert.equal((await status()).status, "unverified");
});

test("one 👍 isn't enough; 👍 from two networks verifies", async () => {
  await vote("worked");
  assert.equal((await status()).status, "unverified");
  await vote("worked");
  assert.equal((await status()).status, "verified");
});

test("many installs on one network count as one vote", async () => {
  for (let i = 0; i < 5; i++) await vote("worked", { client: `sybil-${i}xxxx`, net: "same-net" });
  const st = await status();
  assert.deepEqual([st.reports, st.status], [1, "unverified"]);
});

test("old 👍 don't verify", async () => {
  await vote("worked", { ago: 20 * DAY });
  await vote("worked", { ago: 20 * DAY });
  assert.equal((await status()).status, "unverified");
});

test("the sharer can't vote their own code up, from their install or their network", async () => {
  await core.addCode(db, { domain: "shop.com", code: "MINE5", submittedBy: "client-sharer", submittedNet: "net-sharer" }, NOW);
  await vote("worked", { code: "MINE5", client: "client-sharer", net: "net-other1" });
  await vote("worked", { code: "MINE5", client: "client-alt-001", net: "net-sharer" });
  assert.equal((await status("MINE5")).reports, 0);
});

test("three 👎 in a row from different networks mark failing", async () => {
  await vote("worked", { ago: 3 * DAY });
  for (let i = 0; i < 3; i++) await vote("failed", { ago: i * 60 });
  assert.equal((await status()).status, "failing");
});

test("one vote per install per code: the latest replaces the earlier", async () => {
  await vote("worked", { client: "client-same1", net: "net-a", ago: 5 * DAY });
  await vote("failed", { client: "client-same1", net: "net-b" });
  const st = await status();
  assert.deepEqual([st.reports, st.worked], [1, 0]);
});

test("ordering: verified first, then by success rate", async () => {
  for (const c of ["GOOD", "OKAY", "BAD"]) await core.addCode(db, { domain: "shop.com", code: c }, NOW);
  await vote("worked", { code: "GOOD" }); await vote("worked", { code: "GOOD" });
  await vote("worked", { code: "OKAY" }); await vote("failed", { code: "OKAY" });
  for (let i = 0; i < 3; i++) await vote("failed", { code: "BAD" });
  assert.deepEqual((await core.listCodes(db, "shop.com", NOW)).map((c) => c.code), ["GOOD", "OKAY", "SAVE10", "BAD"]);
});

test("shoppers' descriptions aren't stored; shop-sourced ones are", async () => {
  await core.addCode(db, { domain: "shop.com", code: "FREE5", description: "Visit evil.example for more" }, NOW);
  assert.equal((await status("FREE5")).description, "");
  assert.equal((await status("SAVE10")).description, "10% off");
});

test("public suffixes and localhost are rejected", async () => {
  for (const d of ["co.uk", "myshopify.com", "github.io", "workers.dev", "localhost", "com"]) {
    await assert.rejects(core.addCode(db, { domain: d, code: "X12" }, NOW), core.BadRequest, d);
  }
  await core.addCode(db, { domain: "shop.co.uk", code: "UK10" }, NOW); // a shop under one is fine
  core.config.allowLocalhost = true;
  await core.addCode(db, { domain: "localhost", code: "DEV1" }, NOW);
});

test("submissions dedupe case-insensitively and normalise www", async () => {
  assert.equal((await core.addCode(db, { domain: "www.Shop.com", code: "save10" }, NOW)).new, false);
  assert.equal((await core.addCode(db, { domain: "shop.com", code: "NEW5" }, NOW)).new, true);
});

test("votes on unknown codes are rejected", async () => {
  await assert.rejects(vote("worked", { code: "NOPE" }), core.BadRequest);
});

test("validation", async () => {
  await assert.rejects(core.addReport(db, null, NOW, { net: "x" }), core.BadRequest);
  for (const bad of [{ domain: "not a domain" }, { code: "has space" }, { client_id: "x" }, { outcome: "maybe" }]) {
    const body = { domain: "shop.com", code: "SAVE10", outcome: "worked", client_id: "client-0001", ...bad };
    await assert.rejects(core.addReport(db, body, NOW, { net: "x" }), core.BadRequest);
  }
});

test("shop list: seeded shops, or a shared code with 👍 from 3 networks other than the sharer's", async () => {
  await core.addCode(db, { domain: "junk.com", code: "SPAM1", submittedBy: "client-spam", submittedNet: "net-spam" }, NOW);
  await vote("worked", { domain: "junk.com", code: "SPAM1" });
  await vote("worked", { domain: "junk.com", code: "SPAM1" });
  await vote("worked", { domain: "junk.com", code: "SPAM1", net: "net-spam" }); // sharer's network: ignored
  assert.deepEqual(await core.listDomains(db, NOW), ["shop.com"]);
  await vote("worked", { domain: "junk.com", code: "SPAM1" });
  assert.deepEqual(await core.listDomains(db, NOW), ["junk.com", "shop.com"]);
});

test("expired codes are hidden, and a shop whose only codes expired drops off the list", async () => {
  await core.addCode(db, { domain: "gone.com", code: "OLD10", source: "seed", expires: NOW - 1 }, NOW);
  assert.equal((await core.listCodes(db, "gone.com", NOW)).length, 0);
  assert.ok(!(await core.listDomains(db, NOW)).includes("gone.com"));
});

test("rate limit per install and per network", async () => {
  const keys = { client: "client-0001", net: "net-x" };
  for (let i = 0; i < core.LIMITS.submit.client; i++) await core.rateLimit(db, "submit", keys, NOW);
  await assert.rejects(core.rateLimit(db, "submit", keys, NOW), (e) => e.status === 429);
  await core.rateLimit(db, "submit", keys, NOW + DAY + 1); // window passed
  for (let i = 0; i < core.LIMITS.submit.net; i++) {
    try { await core.rateLimit(db, "submit", { client: `c-${i}-xxxxxx`, net: "net-y" }, NOW); } catch {}
  }
  await assert.rejects(core.rateLimit(db, "submit", { client: "fresh-client", net: "net-y" }, NOW), (e) => e.status === 429);
});

test("cleanup deletes old rate-limit records and old votes", async () => {
  await core.rateLimit(db, "report", { client: "client-0001", net: "n1" }, NOW - 3 * DAY);
  await vote("worked", { ago: 31 * DAY });
  await core.cleanup(db, NOW);
  assert.equal((await db.first("SELECT COUNT(*) AS n FROM hits")).n, 0);
  assert.equal((await db.first("SELECT COUNT(*) AS n FROM reports")).n, 0);
});
