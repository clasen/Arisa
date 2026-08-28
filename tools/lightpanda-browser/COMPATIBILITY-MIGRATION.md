# Authenticated workflow migration probes

Generated: 2026-08-28

Decision rule: replace Chromium only when the exact workflow proves authentication, required browser APIs, expected target coverage, and safe outcome verification. A public page load is not sufficient. No probe used payment fields, private payloads, or a real checkout submission.

| Workflow | Probe evidence | Decision |
|---|---|---|
| `x-campaign-runner` public fallback | Bounded Lightpanda search returned structured `results`; the campaign parser consumes that JSON directly. | Replaced the former public-web fallback with `lightpanda-browser`. Authenticated X search remains first. |
| `x-session-reader` bookmarks/posts | Anonymous `https://x.com/i/bookmarks` was blocked by robots. Lightpanda exposes no allowlisted cookie injection or durable authenticated profile. | Keep Chromium. |
| `x-dm` search/DM/follow/post | Requires injected cookies, persistent local storage/IndexedDB, account pinning, and delivery verification. Lightpanda has no allowlisted cookie injection or durable credential profile. | Keep Chromium. |
| `creator-scout` auth/search/billing | Anonymous saved-account target was blocked by robots. Magic-link authentication must survive external email retrieval and later billing/search operations; Lightpanda sessions are temporary and credential-free. | Keep Chromium. |
| `secure-purchase-wallet` inspect/purchase | Lightpanda policy intentionally blocks payment fields and purchase controls. It cannot prove cross-origin payment iframe or interactive 3-D Secure handling. | Keep Chromium for both inspection and purchase; no real checkout was probed. |
| `browser-session-bridge` shared-session open | Shared-session actions require cookie injection and scoped cookie refresh, which are not exposed by Lightpanda. | Keep Chromium. |
| `browser-session-bridge` Chrome Web Store | Anonymous navigation reached Google sign-in, not the authenticated developer target. Cookie injection, package upload, and durable session refresh are unavailable. | Keep Chromium. |

Lightpanda remains the default only for anonymous public search/rendering. Compatibility failures never authorize an automatic Chromium fallback.
