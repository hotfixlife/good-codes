// Good Codes Worker: serves the site from ./public and the API under /api/.
import * as core from "./core.js";

// Only browser extensions may call the API from a browser. Other websites get no CORS access, and
// their requests are refused, so a website can't make its visitors' browsers vote.
const extensionOrigin = (req) => {
  const o = req.headers.get("origin") || "";
  return /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(o) ? o : null;
};
const corsHeaders = (req) => {
  const o = extensionOrigin(req);
  return o ? { "access-control-allow-origin": o, "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS", vary: "Origin" } : { vary: "Origin" };
};

const json = (req, obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...corsHeaders(req), ...extra } });

const d1 = (DB) => ({
  all: async (sql, ...p) => (await DB.prepare(sql).bind(...p).all()).results,
  first: (sql, ...p) => DB.prepare(sql).bind(...p).first(),
  run: (sql, ...p) => DB.prepare(sql).bind(...p).run(),
});

// The caller's network: IPv4 /24 or IPv6 /48, salted and hashed. Used for one-vote-per-network and limits.
async function netKey(req, salt) {
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const prefix = ip.includes(":")
    ? ip.split(":").slice(0, 3).join(":")      // IPv6 /48 (good enough for compressed forms too)
    : ip.split(".").slice(0, 3).join(".");      // IPv4 /24
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + prefix));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(req) {
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    throw new core.BadRequest("expected application/json", 415);
  }
  const text = await req.text();
  if (!text || text.length > 4096) throw new core.BadRequest("bad length");
  try { return JSON.parse(text); } catch { throw new core.BadRequest("bad json"); }
}

// Short edge caching for the read endpoints, so repeated lookups don't hit the database.
async function cached(req, ctx, seconds, make) {
  const cache = caches.default;
  const key = new Request(new URL(req.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  const body = hit ? await hit.text() : JSON.stringify(await make());
  if (!hit) {
    ctx.waitUntil(cache.put(key, new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${seconds}` } })));
  }
  return new Response(body, { headers: { "content-type": "application/json", ...corsHeaders(req),
    "cache-control": `public, max-age=${seconds}` } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

    core.config.allowLocalhost = env.ALLOW_LOCALHOST === "1"; // set only in .dev.vars for local testing
    const db = d1(env.DB);
    const now = Date.now() / 1000;
    try {
      if (req.method === "GET" && url.pathname === "/api/domains") {
        return await cached(req, ctx, 300, async () => ({ domains: await core.listDomains(db, now) }));
      }
      if (req.method === "GET" && url.pathname === "/api/codes") {
        core.normDomain(url.searchParams.get("domain")); // validate before caching anything
        return await cached(req, ctx, 60, async () => ({ codes: await core.listCodes(db, url.searchParams.get("domain"), now) }));
      }
      if (req.method === "POST" && (url.pathname === "/api/report" || url.pathname === "/api/submit")) {
        if (req.headers.get("origin") && !extensionOrigin(req)) throw new core.BadRequest("not allowed", 403);
        const body = await readBody(req);
        const keys = { client: core.clientId(body), net: await netKey(req, env.IP_SALT || "dev-only-salt") };
        if (url.pathname === "/api/report") {
          await core.rateLimit(db, "report", keys, now);
          return json(req, await core.addReport(db, body, now, { net: keys.net }));
        }
        await core.rateLimit(db, "submit", keys, now);
        return json(req, await core.addCode(db, {
          domain: body.domain, code: body.code, submittedBy: keys.client, submittedNet: keys.net,
        }, now));
      }
      return json(req, { error: "not found" }, 404);
    } catch (e) {
      if (e instanceof core.BadRequest) return json(req, { error: e.message }, e.status);
      console.error(e);
      return json(req, { error: "server error" }, 500);
    }
  },

  // Daily cleanup (see [triggers] in wrangler.toml).
  async scheduled(_event, env) {
    await core.cleanup(d1(env.DB), Date.now() / 1000);
  },
};
