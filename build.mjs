// Builds the site (worker/public) and the extension (dist/goodcodes-extension + a zip download).
//   node build.mjs          production: uses config.json "api" and "bmc"
//   node build.mjs --dev    local: API http://localhost:8787
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "./worker/node_modules/fflate/esm/index.mjs";
import { icon } from "./icons.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const api = dev ? "http://localhost:8787" : cfg.api;
const bmc = cfg.bmc || "#";
if (!/^https?:\/\/[^/]+$/.test(api || "")) {
  console.error('config.json "api" must be the site origin, e.g. https://goodcodes.example.workers.dev');
  process.exit(1);
}

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// Site
const pub = join(ROOT, "worker", "public");
mkdirSync(pub, { recursive: true });
// Empty it rather than remove it: `wrangler dev` watches the folder (and Windows locks it).
for (const f of readdirSync(pub)) rmSync(join(pub, f), { recursive: true, force: true });
cpSync(join(ROOT, "site"), pub, { recursive: true });
for (const f of walk(pub).filter((f) => f.endsWith(".html"))) {
  writeFileSync(f, readFileSync(f, "utf8").replaceAll("__BMC__", bmc));
}
writeFileSync(join(pub, "icon.png"), icon("on", 128));

// Extension
const out = join(ROOT, "dist", "goodcodes-extension");
rmSync(out, { recursive: true, force: true });
const files = {};
for (const f of walk(join(ROOT, "extension"))) {
  const rel = relative(join(ROOT, "extension"), f).replaceAll("\\", "/");
  let text = readFileSync(f, "utf8");
  text = text.replaceAll("__API__", api).replaceAll("__BMC__", bmc === "#" ? "" : bmc);
  mkdirSync(join(out, rel, ".."), { recursive: true });
  writeFileSync(join(out, rel), text);
  files[`goodcodes-extension/${rel}`] = strToU8(text);
}
mkdirSync(join(out, "icons"), { recursive: true });
for (const state of ["on", "off"]) for (const size of [16, 32, 48, 128]) {
  const bytes = icon(state, size);
  writeFileSync(join(out, "icons", `${state}-${size}.png`), bytes);
  files[`goodcodes-extension/icons/${state}-${size}.png`] = bytes;
}
mkdirSync(join(pub, "downloads"), { recursive: true });
writeFileSync(join(pub, "downloads", "goodcodes-extension.zip"), zipSync(files, { level: 9 }));

console.log(`Built for ${api}${dev ? " (dev)" : ""}: site -> worker/public, extension -> dist/goodcodes-extension`);
