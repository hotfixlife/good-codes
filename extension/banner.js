// Good Codes banner. Only injected (by the service worker) into shops that have codes, and only when
// alerts are on. It shows codes and asks "did it work?"; it never reads the page it's on.
(() => {
  if (window.__goodcodes) return;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LABEL = { verified: "works for others", unverified: "not confirmed yet", failing: "recently not working" };

  const host = document.createElement("div");
  // Inline !important beats the page's stylesheets (a page script could still interfere; see SECURITY).
  host.style.cssText = "all:initial !important;position:fixed !important;top:16px !important;right:16px !important;" +
    "z-index:2147483647 !important;display:block !important;opacity:1 !important;visibility:visible !important";
  const root = host.attachShadow({ mode: "closed" }); // the shop's page can't read or change it
  root.innerHTML = `<style>
    .box{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#1d1d1b;
      border:1px solid #d9d6cc;border-left:5px solid #1f7a4d;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);
      padding:12px 14px;width:310px;max-width:calc(100vw - 32px);box-sizing:border-box}
    .t{font-weight:700;margin:0 0 8px;padding-right:20px} .m{margin:0 0 8px;color:#4d4b45}
    .code{display:flex;align-items:center;gap:8px;border-top:1px solid #ece9e1;padding:7px 0}
    .code b{font-family:ui-monospace,Consolas,monospace;font-size:15px} .d{color:#6b6962;font-size:12.5px}
    .grow{flex:1;min-width:0}
    .chip{font-size:11.5px;color:#1f7a4d}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    button{font:inherit;border-radius:8px;border:1px solid #d9d6cc;background:#fff;color:#1d1d1b;padding:5px 11px;cursor:pointer}
    button.p{background:#1f7a4d;color:#fff;border-color:#1f7a4d}
    .x{position:absolute;top:8px;right:10px;border:0;background:none;font-size:18px;padding:0 4px;color:#6b6962}
    .wrap{position:relative}
    @media (prefers-color-scheme: dark){.box{background:#1d1f1c;color:#ecebe6;border-color:#33352f;border-left-color:#4cc285}
      .m,.d{color:#b5b3ab} .code{border-top-color:#33352f} .chip{color:#4cc285}
      button{background:#262824;color:#ecebe6;border-color:#3b3d37} button.p{background:#4cc285;color:#0d1a12;border-color:#4cc285}}
  </style><div class="wrap"><div class="box" role="dialog" aria-label="Good Codes"></div></div>`;
  const box = root.querySelector(".box");
  const mount = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
  const close = () => host.remove();

  function render(html, handlers = {}) {
    mount();
    box.innerHTML = `<button class="x" data-a="close" aria-label="Close">×</button>` + html;
    box.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", (e) => {
      if (!e.isTrusted) return; // only the shopper's own clicks
      const a = b.dataset.a;
      if (a === "close") { handlers.close?.(); close(); } else handlers[a]?.(b);
    }));
  }

  const thanks = () => { render(`<p class="m" style="margin:0">Thanks! That helps the next shopper.</p>`); setTimeout(close, 2500); };

  function offer({ domain, codes }) {
    const shown = codes.slice(0, 3);
    render(`<p class="t">Good Codes: ${codes.length} code${codes.length === 1 ? "" : "s"} for this shop</p>` +
      shown.map((c, i) => `<div class="code"><div class="grow"><b>${esc(c.code)}</b>
        <span class="chip">${esc(c.status === "unverified" && c.fromShop ? "from the shop's site" : LABEL[c.status] || "")}</span>
        ${c.description ? `<div class="d">${esc(c.description)}</div>` : ""}</div>
        <button class="p" data-a="copy" data-i="${i}">Copy</button></div>`).join("") +
      `<p class="d" id="hint" style="margin:6px 0 0">Copy one and paste it into the discount box.${codes.length > 3 ? " More in the toolbar icon." : ""}</p>`, {
      copy: async (b) => {
        const c = shown[b.dataset.i];
        try {
          await navigator.clipboard.writeText(c.code);
        } catch {
          // Some shops block copying; show the code to select by hand instead.
          root.getElementById("hint").textContent = `Copying is blocked on this site. Type ${c.code} into the discount box.`;
          send({ type: "copied", domain, code: c.code });
          return;
        }
        send({ type: "copied", domain, code: c.code });
        box.querySelectorAll('[data-a="copy"]').forEach((x) => { x.textContent = "Copy"; });
        b.textContent = "Copied ✓";
        root.getElementById("hint").textContent = "Paste it into the discount box. We'll ask if it worked.";
      },
      close: () => send({ type: "dismiss", domain }),
    });
  }

  function ask({ domain, code }) {
    render(`<p class="t">Did ${esc(code)} work?</p><p class="m">Your answer helps other shoppers find codes that work.</p>
      <div class="row"><button class="p" data-a="yes">👍 Yes</button><button data-a="no">👎 No</button>
      <button data-a="later">Not sure yet</button></div>`, {
      yes: () => { send({ type: "vote", domain, code, outcome: "worked" }); thanks(); },
      no: () => { send({ type: "vote", domain, code, outcome: "failed" }); thanks(); },
      later: () => { send({ type: "later" }); close(); },
      close: () => send({ type: "later" }),
    });
  }

  window.__goodcodes = { show: (data) => (data.mode === "ask" ? ask(data) : offer(data)) };
})();
