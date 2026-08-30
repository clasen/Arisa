# creator-scout

Search CreatorScout for YouTube and Twitch creators who cover comparable games or genres. Authentication, status, saved-page validation, and search use one persistent Lightpanda profile per chat by default. Checkout and Stripe inspection remain explicitly on Chromium.

## Actions

- `authenticate`: request a CreatorScout magic link, validate the Supabase redirect, and consume the same-site callback in Lightpanda
- `status`: validate `/saved` with the persistent Lightpanda profile
- `search`: search creators by game or genre in Lightpanda, with optional language, recency, and bounded email reveals
- `checkout-quote` and `subscription-status`: remain on the explicit Chromium profile

Pass `engine=chromium` to `authenticate`, `status`, or `search` only when Chromium is deliberately selected. Lightpanda failures never trigger automatic fallback.

Version 1.4 groups deterministic Lightpanda navigation, result polling, extraction, and bounded email reveals through `session-batch`. This reduces tool IPC calls while preserving the same exact-reference filtering, action authorization, output bounds, and explicit session close.

For outreach research, use `requireExactReference=true` with `referenceTitles`. Rows that do not mention an exact title or verified localized alias are removed before any email lookup. Search output remains evidence for later provenance and deduplication review; it does not add contacts or send messages.

## State and credentials

The CreatorScout email is supplied through chat-scoped tool configuration. Lightpanda cookies and web storage are persisted through the chat-scoped browser-session bridge state; the legacy Chromium profile remains separate. Credentials, cookies, storage values, callback tokens, and magic links are never returned in tool output.

`gmail-workspace` is needed only for the `authenticate` action and is therefore not declared as a hard tool dependency. An already authenticated profile can run searches without Gmail.
