# Authenticated workflow migration probes

Generated: 2026-08-28

Decision rule: replace Chromium only when the exact workflow proves authentication, required browser APIs, expected target coverage, and safe outcome verification. A public page load is not sufficient. No probe used payment fields, private payloads, or a real checkout submission.

| Workflow | Probe evidence | Decision |
|---|---|---|
| `x-campaign-runner` public fallback | Bounded Lightpanda search returned structured `results`; the campaign parser consumes that JSON directly. | Replaced the former public-web fallback with `lightpanda-browser`. Authenticated X search remains first. |
| `x-session-reader` bookmarks/posts | The original anonymous probe was blocked by robots. Version 0.11 now supports bridge cookies, scoped cookie refresh, and in-session web storage. | Re-probe the exact authenticated target before replacing Chromium. |
| `x-dm` search/DM/follow/post | Version 0.11 supplies cookies and storage, but account pinning and delivery verification still need exact compatibility evidence. | Re-probe read-only validation first; keep Chromium until every consequential contract passes. |
| `creator-scout` auth/search/billing | The original anonymous saved-account target was blocked by robots. Version 0.11 can retain bridge authentication and in-session web storage, but the current MCP build rejects advertised SQLite persistence flags. | Re-probe authenticated search and billing inspection without purchase. |
| `secure-purchase-wallet` inspect/purchase | Lightpanda still blocks payment fields and purchase controls. Cross-origin payment iframe and interactive 3-D Secure handling are unproven. | Keep Chromium for purchase; separately probe read-only checkout inspection without a real checkout submission. |
| `browser-session-bridge` shared-session open | Version 0.11 loads same-site bridge cookies internally, refreshes them on close, and never returns values. | Re-probe same-site read-only open before replacement. |
| `browser-session-bridge` Chrome Web Store | The original anonymous probe reached Google sign-in. Version 0.11 currently accepts one same-site resource, while this workflow can require both Chrome Web Store and Google Accounts scopes plus upload APIs. | Keep Chromium pending a multi-resource authenticated probe. |

Lightpanda remains the default only for anonymous public search/rendering. Compatibility failures never authorize an automatic Chromium fallback.
