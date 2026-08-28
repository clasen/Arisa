# Authenticated workflow migration probes

Generated: 2026-08-28

Decision rule: replace Chromium only when the exact workflow proves authentication, required browser APIs, expected target coverage, and safe outcome verification. A public page load is not sufficient. No probe used payment fields, private payloads, or a real checkout submission.

| Workflow | Probe evidence | Decision |
|---|---|---|
| `x-campaign-runner` public fallback | Bounded Lightpanda search returned structured `results`; the campaign parser consumes that JSON directly. | Replaced the former public-web fallback with `lightpanda-browser`. Authenticated X search remains first. |
| `x-session-reader` bookmarks/posts | Version 0.11 loaded the shared `x.com` cookies and reached the exact bookmarks URL, but X rendered only “Something went wrong”: no tweet, empty-state, or login target selectors were present. | Keep Chromium; authentication transport works, but the X application target is incompatible. |
| `x-dm` search/DM/follow/post | The authenticated X read-only prerequisite failed at the application target before account pinning or delivery verification could be evaluated. | Keep Chromium; do not expose consequential X actions through Lightpanda. |
| `creator-scout` auth/search/billing | The original anonymous saved-account target was blocked by robots. Version 0.11 can retain bridge authentication and in-session web storage, but the current MCP build rejects advertised SQLite persistence flags. | Re-probe authenticated search and billing inspection without purchase. |
| `secure-purchase-wallet` inspect/purchase | Lightpanda still blocks payment fields and purchase controls. Cross-origin payment iframe and interactive 3-D Secure handling are unproven. | Keep Chromium for purchase; separately probe read-only checkout inspection without a real checkout submission. |
| `browser-session-bridge` shared-session open | Version 0.11 loads same-site bridge cookies internally, refreshes them on close, and never returns values. A synthetic target proved that the server received the imported cookie and that the refreshed jar returned to the bridge. The real stored `x.com` target remained application-incompatible. | Keep the generic Chromium action because arbitrary stored targets cannot be declared compatible from one synthetic pass. |
| `browser-session-bridge` Chrome Web Store | The original anonymous probe reached Google sign-in. Version 0.11 currently accepts one same-site resource, while this workflow can require both Chrome Web Store and Google Accounts scopes plus upload APIs. | Keep Chromium pending a multi-resource authenticated probe. |

Lightpanda remains the default only for anonymous public search/rendering. Compatibility failures never authorize an automatic Chromium fallback.
