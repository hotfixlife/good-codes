# Good Codes

A free browser extension that tells you when a shop has promo codes that other shoppers say actually work. Copy one, paste it at checkout, and tell us if it worked.

- Website: https://goodcodes.fairshare-worker.workers.dev
- Support it: https://buymeacoffee.com/hotfixlife
- Privacy: https://goodcodes.fairshare-worker.workers.dev/privacy · Security: https://goodcodes.fairshare-worker.workers.dev/security

This repository is the complete source for the extension, the server and the website, published so anyone can check exactly what Good Codes does. It's an early test, built and run by [hotfixlife](https://buymeacoffee.com/hotfixlife).

## How it works, in plain English

1. **You install the extension.** Nothing about you is sent anywhere. It downloads a list of shops that have codes.
2. **It tells you when a shop has codes.**
   - *Alerts off (default):* Chrome itself turns the toolbar icon green on those shops. The extension isn't told which sites you visit.
   - *Alerts on (you choose, and Chrome asks you to allow it):* the extension checks each site's address against the shop list **on your computer** and shows a small banner on listed shops' cart and checkout pages. Only listed shops' names are ever sent.
3. **You copy a code** from the banner or the icon and paste it into the shop's discount box yourself. The extension never reads or fills in the page.
4. **It asks if it worked.** With alerts on, it asks "Did SAVE15 work? 👍 / 👎" on the shop's order-confirmation page; if you leave the shop first (payment providers like PayPal don't count), a Chrome notification asks. With alerts off, the icon asks next time you open it.
5. **Votes decide which codes show as "works for others".** A code needs 👍 from two different internet connections in the last two weeks (neither of them the sharer's) and at least half of its recent votes positive. Each connection gets one vote per code. Three 👎 in a row marks it as not working.
6. **Anyone can share a code** from the icon. Only share codes meant for everyone.

Good Codes never touches affiliate links or cookies, so the creator who sent you to a shop still gets paid. It's free while we test it; we'll probably charge later (most likely a small fee), and we'll ask first.

## What goes where

```
Your browser                                      Cloudflare
┌──────────────────────────────────┐              ┌───────────────────────────────────┐
│ Extension (no third-party code)   │   HTTPS      │ Worker "goodcodes"                │
│  • shop list, kept locally        │◄────────────►│  • website (privacy, security)    │
│  • icon / optional banner         │  only a      │  • API: codes, votes, shared      │
│  • copy code, ask "did it work?"  │  shop's name │    codes (validated, rate-limited)│
└──────────────────────────────────┘  + your votes │ D1 database: codes, votes         │
                                                  └───────────────────────────────────┘
```

**Sent to the server:** a shop's name when we need its codes (when you click the icon, or with alerts on when you open a listed shop's cart or checkout), your 👍/👎, and codes you choose to share. Votes carry a random install ID. The server keeps a salted hash of your network (IPv4 /24, IPv6 /48): two days for rate limits, 30 days with votes so each network votes once. Votes are deleted after 30 days. No accounts, emails, names, baskets or other browsing.

**Security review:** see [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) for our own adversarial review and what we changed.

**Permissions:** `storage`, `alarms`, `declarativeContent`, `activeTab`, `scripting` at install (Chrome shows no warnings for these). Only if you turn on alerts: access to sites (to check addresses locally and show the banner) and `notifications`.

## Repository layout

| Path | What |
|---|---|
| `extension/` | Chrome Manifest V3 extension. `background.js` (shop list, green icon, alerts), `banner.js` (on-page banner, closed shadow DOM, never reads the page), `popup.*` (icon popup), `welcome.*` (first-run page), `api.js` (shared helpers; `__API__`/`__BMC__` are filled in by the build) |
| `worker/` | Cloudflare Worker: `src/index.js` (HTTP + static site), `src/core.js` (verification rules, rate limits), `schema.sql`, tests |
| `site/` | Website: landing page, privacy, security, demo checkout, security headers (`_headers`) |
| `extension-test/` | Behaviour tests for `background.js` with a fake `chrome` API |
| `build.mjs`, `icons.mjs` | Builds the extension (and its icons) and the site |
| `config.json` | Public settings: the site address and the Buy Me a Coffee link |

## Build, test, deploy

```
cd worker && npm install
npm test                                   # server logic (node:sqlite)
node --test ../extension-test/background.test.mjs   # extension behaviour
npm run db:local && npm run build:dev && npx wrangler dev   # local site + API on :8787
```
Load the built extension from `dist/goodcodes-extension` via `chrome://extensions` → Developer mode → Load unpacked.

Deploying needs the Cloudflare account (`npx wrangler login`), then `npm run deploy` from `worker/`. The IP-hash salt is a Worker secret (`wrangler secret put IP_SALT`) and isn't in this repository.

## Found a problem?

Please open an issue on this repository. For anything security-sensitive, say so in the issue title without the details, and we'll arrange a private way to share them.

## Licence

The source is published for transparency. All rights reserved for now; please ask before reusing it.
