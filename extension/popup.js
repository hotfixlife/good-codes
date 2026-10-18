import { API, BMC, CODE_RE, LABEL, alertsOn, cleanCodes, forgetCopy, get, hostOf, lastCopyFor, post, rememberCopy } from "./api.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ASK_FOR = 24 * 3600 * 1000; // ask "did it work?" for a day after copying

function meta(c) {
  const bits = [];
  if (c.worked) bits.push(`${c.worked} said it worked`);
  if (c.last_worked) bits.push(`last ${new Date(c.last_worked * 1000).toLocaleDateString()}`);
  if (c.reports && c.success_rate !== null) bits.push(`${Math.round(c.success_rate * 100)}% of ${c.reports}`);
  return bits.join(" · ") || "no votes yet";
}

async function vote(domain, code, outcome) {
  await post("/api/report", { domain, code, outcome });
  await forgetCopy(domain, code);
}

// "Did it work?" for the code copied most recently on this shop.
async function showAsk(domain) {
  const code = await lastCopyFor(domain);
  const ask = $("ask");
  if (!code) { ask.hidden = true; return; }
  ask.hidden = false;
  ask.innerHTML = `<p>Did <b>${esc(code)}</b> work?</p>
    <div class="row"><button class="p" data-a="worked">👍 Yes</button><button data-a="failed">👎 No</button>
    <button data-a="skip" style="margin-left:auto">Not yet</button></div>`;
  ask.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.a === "skip") { ask.hidden = true; return; }
    await vote(domain, code, b.dataset.a);
    ask.innerHTML = "<p>Thanks! That helps the next shopper.</p>";
    load(domain);
  }));
}

let tab = null;

async function load(domain) {
  let codes = [];
  try { codes = cleanCodes(await get("/api/codes?domain=" + encodeURIComponent(domain))); } catch {}
  const list = $("list");
  if (!codes.length) { list.className = "muted"; list.textContent = "No codes for this shop yet."; return; }
  list.className = "";
  list.innerHTML = `<p class="muted" style="margin:0 0 8px">Copy a code and paste it into the shop's discount box.</p>` +
    codes.map((c, i) => `
    <div class="code">
      <div class="row"><b>${esc(c.code)}</b><span class="chip ${c.status}">${LABEL[c.status]}</span></div>
      ${c.description ? `<div>${esc(c.description)}</div>` : ""}
      ${c.fromShop ? `<div class="meta">${c.sourceUrl ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">From the shop's own site</a>` : "From the shop's own site"}</div>` : ""}
      <div class="meta">${esc(meta(c))}</div>
      <div class="row" style="margin-top:6px">
        <button class="p" data-i="${i}" data-a="copy">Copy</button>
        <span class="muted" style="flex:1;text-align:right">Worked?</span>
        <button data-i="${i}" data-a="worked" aria-label="It worked">👍</button>
        <button data-i="${i}" data-a="failed" aria-label="It didn't work">👎</button>
      </div>
    </div>`).join("");
  list.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
    const c = codes[b.dataset.i];
    if (b.dataset.a === "copy") {
      await navigator.clipboard.writeText(c.code);
      await rememberCopy({ domain, code: c.code, tabId: tab?.id, url: tab?.url });
      b.textContent = "Copied ✓";
      return;
    }
    await vote(domain, c.code, b.dataset.a);
    b.parentElement.querySelector("span").textContent = "Thanks!";
  }));
}

// Alerts switch (Chrome asks for permission when turning it on).
async function showAlerts() {
  const el = $("alerts");
  if (await alertsOn()) {
    el.innerHTML = `Alerts are on. <a href="#" id="alerts-off">Turn off</a>`;
    $("alerts-off").addEventListener("click", async (e) => {
      e.preventDefault();
      await chrome.permissions.remove({ origins: ["http://*/*", "https://*/*"], permissions: ["notifications"] });
      showAlerts();
    });
  } else {
    el.innerHTML = `Want a heads-up on shops with codes? <button class="p" id="alerts-on">Turn on alerts</button>`;
    // Chrome's permission prompt can close this popup, so ask from the welcome page instead.
    $("alerts-on").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }));
  }
}

(async () => {
  $("site").href = API + "/";
  if (BMC.startsWith("https://")) { $("bmc").href = BMC; $("bmc").hidden = false; }

  // activeTab: Chrome tells us the current tab's address only because you clicked the icon.
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  showAlerts();
  const domain = hostOf(tab?.url || "");
  $("domain").textContent = domain || "Open a shop to see its codes";
  if (!domain) { $("list").textContent = ""; return; }
  $("share").hidden = false;

  showAsk(domain);
  load(domain);

  $("submit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const code = String(f.get("code")).trim();
    if (!CODE_RE.test(code)) { $("submit-msg").textContent = "Codes are letters, numbers, - and _ only."; return; }
    const res = await post("/api/submit", { domain, code });
    $("submit-msg").textContent = res.error ? "Couldn't share that just now. Try again later."
      : res.new ? "Thanks! It shows as confirmed once someone else says it worked." : "We already have that one.";
    if (!res.error) { e.target.reset(); load(domain); }
  });
})();
