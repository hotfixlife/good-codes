// Good Codes core: code database, 👍/👎 votes, submissions, rate limits, cleanup.
// Storage goes through a tiny db interface so the same logic runs on Cloudflare D1 and in tests:
//   db.all(sql, ...params) -> rows,  db.first(sql, ...params) -> row|null,  db.run(sql, ...params)
//
// "net" is a salted hash of the voter's network (IPv4 /24, IPv6 /48), computed in index.js. Votes count
// once per network per code, so faking votes needs many networks, not just many install ids.

export const DAY = 86400;

// Verification rules (provisional; tune once there's real traffic).
export const RULES = {
  windowDays: 30,          // votes older than this stop counting (and are deleted by cleanup)
  verifiedWithinDays: 14,  // "works for others" needs 👍 this recent...
  verifiedVoters: 2,       // ...from at least this many different networks (not the sharer's)
  minSuccessRate: 0.5,     // and at least this share of the last 10 votes
  failingStreak: 3,        // this many 👎 in a row (from different networks) marks a code as failing
  listVoters: 3,           // a shared code puts its shop on the list after 👍 from this many networks
};

// Rate limits per window, applied to both the install id and the network.
export const LIMITS = {
  report: { window: 3600, client: 60, net: 120 },
  submit: { window: DAY, client: 10, net: 20 },
};

export const config = { allowLocalhost: false }; // true only in local development (see index.js)

const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

// Shared hosting and country-level suffixes: listing one of these would light up every site under it.
// (Not the full Public Suffix List; covers the common ones. A shop *under* one, e.g. shop.co.uk, is fine.)
const PUBLIC_SUFFIXES = new Set(`
co.uk org.uk me.uk ltd.uk plc.uk ac.uk gov.uk com.au net.au org.au co.nz org.nz co.jp ne.jp or.jp
co.kr com.br com.mx com.ar com.co com.cn com.hk com.sg com.tw com.tr com.ua com.pl com.my com.ph
co.in net.in org.in co.za co.id co.il co.th com.vn com.eg com.sa com.pk com.ng com.pe com.ec
myshopify.com shopify.com github.io gitlab.io workers.dev pages.dev vercel.app netlify.app
herokuapp.com appspot.com web.app firebaseapp.com azurewebsites.net cloudfront.net amazonaws.com
blogspot.com wordpress.com wixsite.com squarespace.com weebly.com webflow.io bigcartel.com
myshopline.com mystrikingly.com carrd.co glitch.me onrender.com fly.dev repl.co replit.app
`.split(/\s+/).filter(Boolean));

export class BadRequest extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function normDomain(d) {
  d = String(d ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (d === "localhost" && config.allowLocalhost) return d;
  if (!DOMAIN_RE.test(d) || d.length > 253 || PUBLIC_SUFFIXES.has(d)) throw new BadRequest("bad domain");
  return d;
}

export function normCode(c) {
  c = String(c ?? "").trim();
  if (!CODE_RE.test(c)) throw new BadRequest("bad code");
  return c;
}

export function clientId(body) {
  if (!body || typeof body !== "object") throw new BadRequest("bad body");
  const cid = String(body.client_id ?? "");
  if (cid.length < 8 || cid.length > 64) throw new BadRequest("bad client_id");
  return cid;
}

/** reports: newest first, each {outcome, ts}, already excluding the sharer's own votes. */
export function codeStatus(reports, now) {
  const recent = reports.filter((r) => now - r.ts <= RULES.windowDays * DAY);
  const worked = recent.filter((r) => r.outcome === "worked");
  const last10 = recent.slice(0, 10);
  const rate = last10.length ? last10.filter((r) => r.outcome === "worked").length / last10.length : null;
  const info = {
    reports: recent.length,
    worked: worked.length,
    success_rate: rate,
    last_worked: worked.length ? Math.max(...worked.map((r) => r.ts)) : null,
  };
  let status = "unverified";
  const freshWorked = worked.filter((r) => now - r.ts <= RULES.verifiedWithinDays * DAY).length;
  if (recent.length >= RULES.failingStreak &&
      recent.slice(0, RULES.failingStreak).every((r) => r.outcome === "failed")) {
    status = "failing";
  } else if (freshWorked >= RULES.verifiedVoters && rate !== null && rate >= RULES.minSuccessRate) {
    status = "verified";
  }
  return { status, ...info };
}

const RANK = { verified: 0, unverified: 1, failing: 2 };
const FROM_SHOP = new Set(["seed", "merchant"]);

export async function listCodes(db, domain, now) {
  domain = normDomain(domain);
  const rows = await db.all(
    `SELECT c.id, c.code, c.description, c.source, c.source_url, c.expires, r.outcome, r.ts
       FROM codes c LEFT JOIN reports r
         ON r.code_id = c.id AND r.ts > ? AND r.client_id != c.submitted_by AND r.net != c.submitted_net
      WHERE c.domain = ? AND (c.expires IS NULL OR c.expires > ?) ORDER BY c.id, r.ts DESC`,
    now - RULES.windowDays * DAY, domain, now);
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      const fromShop = FROM_SHOP.has(row.source);
      byId.set(row.id, { code: row.code, source: row.source,
        // Only descriptions we wrote from the shop's own page are shown; shoppers' free text isn't.
        description: fromShop ? row.description : "",
        source_url: fromShop ? row.source_url || null : null, expires: row.expires ?? null, reports: [] });
    }
    if (row.outcome) byId.get(row.id).reports.push({ outcome: row.outcome, ts: row.ts });
  }
  const out = [...byId.values()].map(({ reports, ...c }) => ({ ...c, ...codeStatus(reports, now) }));
  out.sort((a, b) => RANK[a.status] - RANK[b.status] || (b.success_rate ?? 0) - (a.success_rate ?? 0) ||
    b.worked - a.worked || (b.last_worked ?? 0) - (a.last_worked ?? 0));
  return out;
}

/** Shops on the list (icon turns green, banner may show): shops we seeded from their own published
 *  codes, or where a shared code got 👍 from several different networks. */
export async function listDomains(db, now) {
  const rows = await db.all(
    `SELECT DISTINCT c.domain FROM codes c
      WHERE (c.expires IS NULL OR c.expires > ?) AND (c.source IN ('seed', 'merchant')
         OR (SELECT COUNT(DISTINCT r.net) FROM reports r WHERE r.code_id = c.id AND r.outcome = 'worked'
              AND r.client_id != c.submitted_by AND r.net != c.submitted_net AND r.ts > ?) >= ?)
      ORDER BY c.domain`, now, now - RULES.windowDays * DAY, RULES.listVoters);
  return rows.map((r) => r.domain).filter((d) => d !== "localhost" || config.allowLocalhost);
}

async function findCode(db, domain, code) {
  return db.first("SELECT id FROM codes WHERE domain = ? AND lower(code) = lower(?)", domain, code);
}

export async function addCode(db, { domain, code, description = "", source = "submitted", submittedBy = "",
  submittedNet = "", expires = null, sourceUrl = "" }, now) {
  domain = normDomain(domain);
  code = normCode(code);
  description = FROM_SHOP.has(source) ? String(description ?? "").trim().slice(0, 200) : "";
  if (await findCode(db, domain, code)) return { ok: true, new: false };
  await db.run(
    `INSERT INTO codes (domain, code, description, source, submitted_by, submitted_net, created, expires, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    domain, code, description, source, submittedBy, submittedNet, now, expires, sourceUrl);
  return { ok: true, new: true };
}

export async function addReport(db, body, now, { net }) {
  const cid = clientId(body);
  const domain = normDomain(body.domain);
  const code = normCode(body.code);
  const outcome = body.outcome;
  if (!["worked", "failed"].includes(outcome)) throw new BadRequest("bad outcome");
  const row = await findCode(db, domain, code);
  if (!row) throw new BadRequest("unknown code");
  // One vote per install and one per network, per code: the latest replaces earlier ones.
  await db.run("DELETE FROM reports WHERE code_id = ? AND (client_id = ? OR net = ?)", row.id, cid, net);
  await db.run("INSERT INTO reports (code_id, outcome, source, saving, client_id, net, ts) VALUES (?, ?, 'user', NULL, ?, ?, ?)",
    row.id, outcome, cid, net, now);
  return { ok: true };
}

/** Throws 429 if the install or the network is over its limit; otherwise records the hit. */
export async function rateLimit(db, kind, { client, net }, now) {
  const lim = LIMITS[kind];
  for (const [key, max] of [[`c:${client}`, lim.client], [`n:${net}`, lim.net]]) {
    const { n } = await db.first("SELECT COUNT(*) AS n FROM hits WHERE kind = ? AND key = ? AND ts > ?",
      kind, key, now - lim.window);
    if (n >= max) throw new BadRequest("too many requests, try again later", 429);
  }
  await db.run("INSERT INTO hits (kind, key, ts) VALUES (?, ?, ?), (?, ?, ?)",
    kind, `c:${client}`, now, kind, `n:${net}`, now);
}

/** Daily: delete rate-limit records after 2 days and votes after 30 days (they've stopped counting). */
export async function cleanup(db, now) {
  await db.run("DELETE FROM hits WHERE ts < ?", now - 2 * DAY);
  await db.run("DELETE FROM reports WHERE ts < ?", now - RULES.windowDays * DAY);
}
