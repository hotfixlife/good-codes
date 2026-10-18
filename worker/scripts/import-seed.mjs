// Turns seed/codes-*.json (codes shops publish themselves) into SQL for D1.
//   node scripts/import-seed.mjs <seed dir> > seed.sql
//   npx wrangler d1 execute fairshare --remote --file seed.sql
// Existing codes are left alone (INSERT OR IGNORE). Expired codes and anything malformed are skipped.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
const AGGREGATORS = /retailmenot|joinhoney|coupons\.com|couponfollow|dealspotr|knoji|slickdeals|groupon|wethrift|couponcabin|savings\.com|offers\.com|dealnews/i;
const q = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const now = Date.now() / 1000;

let review = { skip: [], expires: {} };
try { review = { ...review, ...JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) }; } catch {}
const rows = [], skipped = [];
for (const f of readdirSync(dir).filter((f) => /^codes-.*\.json$/.test(f))) {
  const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const shop of data.shops || []) {
    const domain = String(shop.domain || "").toLowerCase().replace(/^www\./, "");
    for (const c of shop.codes || []) {
      const key = `${domain} ${c.code}`;
      if (review.skip.includes(key)) { skipped.push(`${key}: reviewed out`); continue; }
      if (review.expires[key]) c.expires = review.expires[key];
      const why = !DOMAIN_RE.test(domain) ? "bad domain" : !CODE_RE.test(String(c.code)) ? "bad code"
        : !/^https:\/\//.test(c.source_url || "") ? "no https source" : AGGREGATORS.test(c.source_url) ? "aggregator source"
        : null;
      const expires = c.expires ? Date.parse(c.expires + "T23:59:59Z") / 1000 : null;
      if (why || (expires && expires < now)) { skipped.push(`${domain} ${c.code}: ${why || "expired"}`); continue; }
      const desc = String(c.description || "").slice(0, 120);
      rows.push(`INSERT OR IGNORE INTO codes (domain, code, description, source, created, expires, source_url) VALUES ` +
        `(${q(domain)}, ${q(c.code)}, ${q(desc)}, 'seed', ${now}, ${expires ?? "NULL"}, ${q(c.source_url)});`);
    }
  }
}
console.log(rows.join("\n"));
console.error(`${rows.length} codes to import, ${skipped.length} skipped${skipped.length ? ":\n  " + skipped.join("\n  ") : ""}`);
