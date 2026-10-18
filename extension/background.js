// Good Codes service worker.
// Always: keeps the list of supported shops and asks Chrome to turn the toolbar icon green on them
// (declarativeContent: Chrome does the matching, the extension isn't told which page you're on).
// With alerts on (opt-in, see ALERTS): checks each tab's address against that list on this
// computer, shows a banner on shops with codes, and asks "did it work?" after you copy a code.
// Addresses are never sent anywhere; only a matched shop's name is used to fetch its codes.
import { CODE_RE, DOMAIN_RE, alertsOn, cleanCodes, forgetCopy, get, hostOf, post, rememberCopy } from "./api.js";

// ---- Shop list and the green icon -----------------------------------------------------------------

async function iconData(state) {
  const out = {};
  for (const size of [16, 32]) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/${state}-${size}.png`))).blob();
    const bmp = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(size, size).getContext("2d");
    ctx.drawImage(bmp, 0, 0, size, size);
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

const removeRules = () => new Promise((r) => chrome.declarativeContent.onPageChanged.removeRules(undefined, r));
const addRules = (rules) => new Promise((r) => chrome.declarativeContent.onPageChanged.addRules(rules, r));

async function lightUp(domains) {
  await removeRules();
  const conditions = domains.flatMap((d) => [
    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: d } }),
    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: "." + d } }),
  ]);
  if (!conditions.length) return;
  await addRules([{ conditions, actions: [new chrome.declarativeContent.SetIcon({ imageData: await iconData("on") })] }]);
}

async function refresh() {
  try {
    const { domains } = await get("/api/domains");
    if (!Array.isArray(domains)) return;
    const clean = domains.filter((d) => typeof d === "string" && DOMAIN_RE.test(d));
    await chrome.storage.local.set({ domains: clean, domainsAt: Date.now() });
    await lightUp(clean);
  } catch (e) {
    console.warn("Good Codes: couldn't refresh the shop list", e);
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  refresh();
  chrome.alarms.create("domains", { periodInMinutes: 360 });
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
chrome.runtime.onStartup.addListener(async () => {
  // Tab ids restart with the browser, so questions tied to old tabs are meaningless now.
  await chrome.storage.local.remove("pendings");
  chrome.alarms.create("domains", { periodInMinutes: 360 });
  refresh();
});
chrome.alarms.onAlarm.addListener((a) => a.name === "domains" && refresh());

// ---- Alerts (opt-in) --------------------------------------------------------------------------------

const sameShop = (host, domain) => host === domain || host.endsWith("." + domain);
const DISMISS_FOR = 12 * 3600 * 1000; // closing the banner hides it on that shop for 12 hours
const PENDING_FOR = 24 * 3600 * 1000; // a copied code is asked about for up to a day

// Only the address is looked at (never the page). Cart/checkout pages get the banner; an order
// confirmation page is the moment to ask "did it work?".
const CHECKOUT_PATH = /\/(cart|basket|bag|checkouts?|order|payment|shipping|billing)(\/|$)/i;
const CONFIRMATION_PATH = /(thank[-_]?you|thanks|order[-_]?(confirmation|received|complete|success)|confirmation|receipt|\/success|\/orders\/)/i;
// Going to these mid-checkout isn't "leaving the shop".
const PAYMENT_HOSTS = /(^|\.)(paypal\.com|shop\.app|shopify\.com|stripe\.com|klarna\.com|afterpay\.com|clearpay\.co\.uk|affirm\.com|sezzle\.com|zip\.co|pay\.google\.com|pay\.amazon\.com|adyen\.com|checkout\.com|braintreegateway\.com|cardinalcommerce\.com|arcot\.com|paddle\.com|3dsecure\.io)$/i;

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return ""; } };

// Event handlers can overlap; run them one at a time so stored state isn't clobbered.
let queue = Promise.resolve();
const serial = (fn) => (...args) => (queue = queue.then(() => fn(...args)).catch((e) => console.warn("Good Codes:", e)));

async function getPendings() {
  const { pendings = {} } = await chrome.storage.local.get("pendings");
  for (const [tabId, p] of Object.entries(pendings)) if (Date.now() - p.at > PENDING_FOR) delete pendings[tabId];
  return pendings;
}
const setPendings = (pendings) => chrome.storage.local.set({ pendings });

async function shopFor(host) {
  if (!host) return null;
  const { domains = [] } = await chrome.storage.local.get("domains");
  return domains.find((d) => sameShop(host, d)) || null;
}

async function inject(tabId, data) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["banner.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, func: (d) => window.__goodcodes.show(d), args: [data] });
    return true;
  } catch {
    return false; // e.g. the tab navigated away mid-injection
  }
}

async function offerCodes(tabId, domain) {
  const { shown = {} } = await chrome.storage.session.get("shown");
  if (shown[tabId]?.includes(domain)) return;
  shown[tabId] = [...(shown[tabId] || []), domain]; // once per tab per shop, even if there's nothing to show
  await chrome.storage.session.set({ shown });
  const { dismissed = {} } = await chrome.storage.local.get("dismissed");
  if (dismissed[domain] && Date.now() - dismissed[domain] < DISMISS_FOR) return;
  let codes = [];
  try { codes = cleanCodes(await get("/api/codes?domain=" + encodeURIComponent(domain))); } catch {}
  // The banner only shows codes other shoppers confirmed, or that the shop published itself.
  codes = codes.filter((c) => c.status === "verified" || (c.fromShop && c.status !== "failing"));
  if (codes.length) await inject(tabId, { mode: "offer", domain, codes });
}

// Left the shop or closed the tab before answering: ask with a Chrome notification instead.
async function askByNotification(tabId, pendings) {
  const p = pendings[tabId];
  delete pendings[tabId];
  await setPendings(pendings);
  if (!(await chrome.permissions.contains({ permissions: ["notifications"] }))) return;
  listenToNotifications();
  const id = `gc-ask-${Date.now()}`;
  const { notified = {} } = await chrome.storage.local.get("notified");
  notified[id] = { domain: p.domain, code: p.code };
  await chrome.storage.local.set({ notified });
  chrome.notifications.create(id, {
    type: "basic", iconUrl: "icons/on-128.png", requireInteraction: true,
    title: `Did ${p.code} work?`,
    message: `On ${p.domain}. Your answer helps other shoppers find codes that work.`,
    buttons: [{ title: "👍 Yes, it worked" }, { title: "👎 No" }],
  });
}

// chrome.notifications only exists once the user has allowed it, so register when we can.
let notifListening = false;
function listenToNotifications() {
  if (notifListening || !chrome.notifications) return;
  notifListening = true;
  chrome.notifications.onButtonClicked.addListener(serial(onNotificationButton));
}
listenToNotifications();

async function onNotificationButton(id, index) {
  if (!id.startsWith("gc-ask-")) return;
  chrome.notifications.clear(id);
  const { notified = {} } = await chrome.storage.local.get("notified");
  const n = notified[id];
  delete notified[id];
  await chrome.storage.local.set({ notified });
  if (n) {
    await post("/api/report", { domain: n.domain, code: n.code, outcome: index === 0 ? "worked" : "failed" });
    await forgetCopy(n.domain, n.code);
  }
}

async function onUpdated(tabId, info, tab) {
  if (!(await alertsOn())) return;
  const url = info.url || tab.url;
  if (!url) return;
  const host = hostOf(url);
  const path = pathOf(url);

  const pendings = await getPendings();
  const p = pendings[tabId];
  if (p) {
    if (PAYMENT_HOSTS.test(host)) return;                                     // still paying
    if (!sameShop(host, p.domain)) return askByNotification(tabId, pendings); // left the shop
    const done = info.status === "complete" || (info.url && tab.status === "complete");
    if (done && path !== p.path && CONFIRMATION_PATH.test(path)) {            // order placed: ask now
      delete pendings[tabId];
      await setPendings(pendings);
      await inject(tabId, { mode: "ask", domain: p.domain, code: p.code });
      return;
    }
    if (path !== p.path) { pendings[tabId] = { ...p, path }; await setPendings(pendings); }
    return;
  }

  if (info.status === "complete" && CHECKOUT_PATH.test(path) && !CONFIRMATION_PATH.test(path)) {
    const domain = await shopFor(host);
    if (domain) await offerCodes(tabId, domain);
  }
}
chrome.tabs.onUpdated.addListener(serial(onUpdated));

chrome.tabs.onRemoved.addListener(serial(async (tabId) => {
  const pendings = await getPendings();
  if (pendings[tabId]) await askByNotification(tabId, pendings);
  const { shown = {} } = await chrome.storage.session.get("shown");
  if (shown[tabId]) { delete shown[tabId]; await chrome.storage.session.set({ shown }); }
}));

// Messages from the banner (always from this extension's own injected script).
const handleMessage = serial(async (msg, sender) => {
  const ok = (m) => DOMAIN_RE.test(String(m.domain)) && CODE_RE.test(String(m.code));
  if (msg.type === "copied" && ok(msg) && sender.tab) {
    await rememberCopy({ domain: msg.domain, code: msg.code, tabId: sender.tab.id, url: sender.tab.url });
  } else if (msg.type === "vote" && ok(msg) && ["worked", "failed"].includes(msg.outcome)) {
    await post("/api/report", { domain: msg.domain, code: msg.code, outcome: msg.outcome });
    await forgetCopy(msg.domain, msg.code);
  } else if (msg.type === "dismiss" && DOMAIN_RE.test(String(msg.domain))) {
    const { dismissed = {} } = await chrome.storage.local.get("dismissed");
    dismissed[msg.domain] = Date.now();
    await chrome.storage.local.set({ dismissed });
  }
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handleMessage(msg, sender).then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});
