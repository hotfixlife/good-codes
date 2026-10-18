# Security review (2026-10-18)

An adversarial review of v0.5 by a separate AI agent, done before this code was published, plus read-only checks of the live site. It was not an independent professional audit. The status column says what we changed in response (v0.6).

**Overall:** no injection (XSS) holes found: the popup and banner escape everything, web pages can't message the extension, and all database queries are parameterised. The serious problems were integrity (gaming the shop list and votes), cost/denial of service on the free plan, and privacy/security claims that overstated things.

## 1. Security (most severe first)

| # | Finding | Status |
|---|---|---|
| S1 | **Anyone could get any domain onto the shop list and put their text in the banner.** Install ids are self-chosen, so one submission plus one 👍 from a second id listed a domain. Public suffixes (`co.uk`, `myshopify.com`, `github.io`, `workers.dev`…) were accepted, and the icon/banner match covers subdomains, so listing `co.uk` would light up every UK site. Unverified shared codes and their free-text descriptions showed in the banner straight away, which is a phishing channel inside a "trusted" overlay. `localhost` was accepted in production. | Fixed: public suffixes and localhost rejected; a shared code only lists its shop after 👍 from 3 different networks; the banner shows only verified codes and codes from the shop's own site; shoppers' free-text descriptions are no longer stored or shown. |
| S2 | **A compromised server or Cloudflare account could do more than "show wrong codes":** pick which shops count as listed (so which shop visits get sent), choose banner content, and swap the downloadable zip (no hash, no signature; "Load unpacked" shows no permission prompt, so a tampered extension installs silently). Unpacked installs never auto-update. | Fixed: honest wording on the Security page; publish SHA-256 hashes and GitHub releases. Planned: 2-step verification on all accounts involved; a Chrome Web Store listing (signed, auto-updating). |
| S3 | **Any website could make its visitors' browsers vote:** CORS was open to all sites and the API accepted `text/plain` bodies, which skip the browser's preflight check. | Fixed: only extension origins get CORS; requests from other sites are refused; JSON content type required. |
| S4 | **Easy to knock over on the free plan:** no limit on code lookups and no caching. The free plan allows ~100k Worker requests/day; a script could exhaust it, or D1's daily read/write allowance. (Free plan stops rather than bills.) | Partly fixed: lookups cached at the edge, so repeated requests don't touch the database. The daily request cap can't be fully protected on a workers.dev address; a custom domain would allow Cloudflare's free rate-limiting rule. |
| S5 | **IP rate limits used the full IPv6 address**, so anyone with a /64 had no limit. | Fixed: limits and votes keyed by network (IPv4 /24, IPv6 /48). |
| S6 | **The banner can be hidden, moved or clickjacked by the page** (its host element lives in the page's DOM; the max z-index is detectable). The closed shadow root and "real clicks only" don't stop this. | Mitigating (inline `!important` styles); documented honestly. Impact is limited to a vote or a copy. |
| S7 | Minor: a `null` request body gave a 500; if the `IP_SALT` secret weren't set, the salt would be a public default. | Fixed (400); the secret is set in production. |

## 2. Integrity and abuse

- **Fake votes were free:** one 👍 from a second install id made a code "works for others"; repeated 👍 pushed it to the top. → Now one vote per network per code; "works for others" needs 👍 from 2 different networks (not the sharer's).
- **Poisoning:** three 👎 from three new ids marked any code "failing". Merchants have a motive to kill their own leaked codes, rivals to kill each other's. → Now needs three different networks; still possible for a determined attacker with proxies.
- **Spam:** only the per-IP cap mattered. → Tighter per-install and per-network limits.
- **What an attack took:** a shell script and a few minutes. Now it takes many distinct networks (residential proxies), which raises the cost but doesn't make it impossible.

## 3. Claims vs. code

| Claim | Problem | Fix |
|---|---|---|
| "Never sends your browsing anywhere" / "Addresses are never sent anywhere" | With alerts on, opening a listed shop automatically sends its name (and the server sees IP and time). The server decides what's listed. Chrome Web Store would call this "web history". | Reword: only the names of listed shops are sent, when you open one with alerts on or click the icon. |
| "The addresses aren't stored" | Full shop URLs (including checkout tokens) were kept in local storage for the "did it work?" prompt. | Store only the shop name and page path, locally, cleared within a day. |
| "Hashed IP kept for up to two days" | Cleanup ran on only 1% of requests. | Daily scheduled cleanup (2 days for rate-limit records, 30 days for votes). |
| "Worst it could do is show wrong codes" / "a code has to be plain letters and numbers" | Descriptions were free text; see S1/S2. | Reworded; shoppers' descriptions removed. |
| "Hard to game" / "limits per person" | Two requests were enough. | Reworded to "harder to game", with the real rule. |
| "Walled off… ignores clicks a website fakes" | Partly true (see S6). | Reworded. |
| "Scripting… only works on sites you've allowed" | `activeTab` + `scripting` could inject into the current tab after an icon click (the code doesn't, but it could). | Reworded. |
| "Never reads or changes the page's content" | It adds a banner. | Reworded. |
| "Nothing stored identifies you… nothing to delete" | Votes linked to an install id form a pseudonymous timeline; votes were never deleted. | Votes now deleted after 30 days; wording says "pseudonymous". |
| "No permission warnings" | True for a Web Store install; for "Load unpacked" there's no prompt at all. | Clarified. |
| "Most likely a small share of what it saves you" | Savings are no longer measured. | Reworded to "a small fee". |
| README table described v0.4 | Out of date. | Updated. |

Chrome behaviours **verified from docs:** tab URLs need `tabs` or host permission; `storage.session` works in the service worker; `permissions.request` needs a click (both places have one); alarms may not survive a restart (now re-created on startup). **Assumed, still to check in a real install:** the green icon (declarativeContent SetIcon) without host permissions; notifications becoming available right after the optional grant; the popup closing when Chrome's permission prompt opens; a shop blocking clipboard writes.

## 4. "Did it work?" logic bugs

1. Asked too early: the first navigation after copying is usually cart → checkout. → Fixed: now asks on an order-confirmation-looking page, or when you leave the shop.
2. Payment redirects (PayPal, Shop Pay, 3-D Secure) counted as leaving the shop and fired a notification mid-payment. → Payment providers are treated as still checking out.
3. Stale tab ids after a browser restart could trigger a random "Did X work?". → Pending questions cleared on startup and expire after 24 hours.
4. One pending slot for everything: a copy in tab B overwrote tab A. → One per tab.
5. With alerts off, closing the tab deleted the popup's question. → Fixed.
6. Race between overlapping page events could double-ask. → Serialised.
7. The banner appeared on every page of a shop. → Only on cart/checkout pages, once per tab.

## 5. Adoption risks

- Cold start: the live shop list had only the demo shop (now being seeded from shops' own published codes).
- "Load unpacked" is a hard sell: Developer mode, keeping the folder, no updates, blocked on managed PCs; Edge nags about developer-mode extensions.
- Asking for all-sites access after the Honey scandal will put some people off, and triggers in-depth Web Store review; a misleading privacy line would be grounds for rejection.
- Few votes: prompts are easy to ignore and Windows notifications often go unseen.
- Merchants can detect and hide the banner, or complain about leaked private or influencer codes.
- Competition: Edge and Chrome have built-in coupon features; Honey, Capital One Shopping and Rakuten apply codes automatically.
- Lookalikes: with public source, someone could publish a "Good Codes" to the Web Store first.

## 6. Reviewer's "fix first" list

1. Reject public suffixes and localhost; list only seeded/curated shops or ones with ≥3 verifying networks.
2. Banner: verified codes only; drop or restrict descriptions.
3. CORS only for extension origins; require JSON; network-based IP limits.
4. Rate limiting and caching in front of every `/api/*` route.
5. Fix the privacy/security wording; scheduled cleanup; set `IP_SALT`.
6. Pending per tab, expiring; clear on startup; ignore hash-only URL changes; ask on leaving checkout.
7. Publish SHA-256 hashes and GitHub releases; 2FA on accounts; prioritise the Chrome Web Store; re-create the alarm on startup.
8. Consider asking for site access per shop instead of all sites.
