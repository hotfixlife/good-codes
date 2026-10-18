// Shared by the service worker and the popup.

// Replaced by build.mjs (production URL, or http://localhost:8787 for --dev).
export const API = "__API__";
// Replaced by build.mjs; empty until a real link is configured.
export const BMC = "__BMC__";

export const DOMAIN_RE = /^(localhost|([a-z0-9-]+\.)+[a-z]{2,})$/;
export const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;

// Alerts (the on-page banner and the "did it work?" prompts) need to know which site a tab is on,
// so they're opt-in: Chrome asks the user for these when they turn alerts on.
export const ALERTS = { origins: ["http://*/*", "https://*/*"], permissions: ["notifications"] };
export const alertsOn = () => chrome.permissions.contains({ origins: ALERTS.origins });

export const LABEL = { verified: "works for others", unverified: "not confirmed yet", failing: "recently not working" };

// Server data is untrusted: keep well-formed codes with a known status, coerce numbers.
export function cleanCodes(res) {
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return (Array.isArray(res?.codes) ? res.codes : [])
    .filter((c) => typeof c?.code === "string" && CODE_RE.test(c.code) && Object.hasOwn(LABEL, c.status))
    .map((c) => ({ code: c.code, status: c.status, description: String(c.description ?? "").slice(0, 200),
      fromShop: c.source === "seed" || c.source === "merchant",
      sourceUrl: typeof c.source_url === "string" && /^https:\/\/[^\s"<>]+$/.test(c.source_url) ? c.source_url : null,
      worked: num(c.worked) ?? 0, reports: num(c.reports) ?? 0, success_rate: num(c.success_rate),
      last_worked: num(c.last_worked) }));
}

// Remember the code just copied so we can ask whether it worked: per tab for alerts (the service
// worker), and per shop for the popup. Only the shop name and page path are kept (no query string,
// so no checkout tokens), only on this computer, and only for a day.
const DAY_MS = 24 * 3600 * 1000;
export async function rememberCopy({ domain, code, tabId, url }) {
  let path = "";
  try { path = new URL(url).pathname; } catch {}
  const at = Date.now();
  const { pendings = {}, lastCopy = {} } = await chrome.storage.local.get(["pendings", "lastCopy"]);
  if (Number.isInteger(tabId)) pendings[tabId] = { domain, code, path, at };
  lastCopy[domain] = { code, at };
  for (const [d, c] of Object.entries(lastCopy)) if (at - c.at > DAY_MS) delete lastCopy[d];
  await chrome.storage.local.set({ pendings, lastCopy });
}

// The popup's "did it work?" for this shop, if a code was copied here in the last day.
export async function lastCopyFor(domain) {
  const { lastCopy = {} } = await chrome.storage.local.get("lastCopy");
  const c = lastCopy[domain];
  return c && Date.now() - c.at < DAY_MS ? c.code : null;
}

// Once answered (anywhere), stop asking about that code.
export async function forgetCopy(domain, code) {
  const { pendings = {}, lastCopy = {} } = await chrome.storage.local.get(["pendings", "lastCopy"]);
  for (const [t, p] of Object.entries(pendings)) if (p.domain === domain && p.code === code) delete pendings[t];
  if (lastCopy[domain]?.code === code) delete lastCopy[domain];
  await chrome.storage.local.set({ pendings, lastCopy });
}

export const hostOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
  } catch { return ""; }
};

// A random install id, created on first use. It isn't linked to you; it just lets one install's
// repeat votes count once.
export async function clientId() {
  const { clientId } = await chrome.storage.local.get("clientId");
  if (clientId) return clientId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ clientId: id });
  return id;
}

export async function get(path) {
  const r = await fetch(API + path);
  return r.json();
}

export async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, client_id: await clientId() }),
  });
  return r.json();
}
