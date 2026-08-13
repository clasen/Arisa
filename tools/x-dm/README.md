# x-dm

Audits X/Twitter outreach history, validates whether a target accepts DMs, safely records verified follow changes, sends one explicitly approved DM at a time, reads or updates the logged-in account bio, and publishes explicitly confirmed posts through a user-provided X web session.

It does not bypass login, CAPTCHAs, recipient restrictions, rate limits, or other X safeguards. Because browser automation can put an account at risk, use conservative caps and review every message before sending.

## Actions

- `audit`: summarize recorded sends, recipients, campaigns, uncertain deliveries, unresolved attempts, and recent attempts without opening X.
- `status`: validate the logged-in X account and include campaign health.
- `check`: open one profile and report whether the DM button is visible; `verifyComposer=true` confirms that the conversation composer actually opens without typing.
- `search`: read a bounded set of visible X post or people results without sending.
- `verify-delivery`: read back an approved message, or match its stored hash, in a bound target conversation to reconcile an uncertain send without retrying it.
- `resolve-uncertain`: record explicit human confirmation using the exact message or its stored hash; it never opens X or retries the send.
- `resolve-uncertain`: record explicit human confirmation of one matching uncertain attempt without reopening or resending the conversation.
- `get-bio`: read the logged-in account bio without changing it.
- `get-thread`: read one exact visible post and its currently loaded replies without publishing anything.
- `update-bio`: replace the bio or append text with `appendText`; requires `confirm=true`, changes only the bio field, and verifies it after saving.
- `create-post`: publish one exact post from the logged-in account; requires `confirm=true`, blocks exact duplicates, and verifies the CreateTweet receipt.
- `reply-post`: reply to one exact visible post; requires `confirm=true` and `dryRun=false`, forbids links, binds the receipt to the target post and exact text, and enforces per-post deduplication, cooldown, and a daily cap.
- `relationship-status`: read the target-bound Follow/Following state without changing it.
- `follow`: follow one profile with `confirm=true`; records whether the follow was tool-created or preexisting and verifies both the target DOM transition and a matching X receipt.
- `unfollow`: unfollow only a tool-created follow marked for later cleanup; requires `confirm=true` and `noResponseConfirmed=true` after checking for a reply.
- `send`: send exactly one message when both `confirm=true` and `dryRun=false` are explicit.

Example dry run:

```json
{
  "chatId": "<chat-id>",
  "args": {
    "action": "send",
    "campaignId": "example-campaign",
    "username": "targethandle",
    "message": "An approved, personalized message.",
    "confirm": "false",
    "dryRun": "true"
  }
}
```

## Reliability model

- Browser sessions use a persistent chat-scoped profile; configured cookies are refreshed for each action.
- A bounded operation deadline and absolute process watchdog prevent permanent browser hangs.
- A chat-scoped lock serializes state-changing work.
- State writes are atomic and malformed state fails closed.
- Confirmed sends reserve an idempotency key before clicking.
- Duplicate recipients, unresolved attempts, cooldown, global and per-campaign daily caps, and a short failure circuit breaker block unsafe retries.
- The tool clicks only an explicit DM send button. It does not use keyboard fallbacks.
- The browser profile persists per chat so X Chat encryption state survives between runs.
- Before typing, the tool binds and observes one stable `/i/chat/<conversationId>` page. Passcode recovery, navigation, or a disappearing composer blocks the send before the click.
- Immediate success requires concrete evidence: the composer clears, one new exact message appears inside the bound conversation's message list, X shows no send error, and a matching successful X send receipt contains the approved text, conversation id, and a stable message or event id.
- When immediate evidence is incomplete, the tool reopens the same bound conversation and looks for the exact message before marking delivery uncertain.
- A draft in the composer, global page text, an unrelated HTTP 200, or only a cleared composer can never count as delivered.
- Otherwise the attempt is marked uncertain and retries are blocked. `verify-delivery` requires the exact unresolved attempt id and bound conversation; it can use the exact message or its stored 16-character hash, and it never resends.
- `EXPECTED_ACCOUNT_HANDLE` can pin the permitted sending account.
- Tool-created follows have their own cooldown and daily cap. Preexisting follows are never eligible for tool-managed unfollow.
- Public campaign replies have a separate cooldown and daily cap. Uncertain delivery blocks retries, and each target post can receive at most one recorded campaign reply.
- Missing follow/unfollow proof records a manual-review state and blocks automatic retries.
- Bio updates require explicit confirmation, modify only the bio field, and reopen the editor to verify X retained the requested content.

Legacy entries created before state version 2 remain visible as campaign `legacy`; they are historical send claims rather than cryptographically verified X delivery receipts.

## Config

`X_COOKIES` may be a JSON cookie array, Netscape cookies file, or raw Cookie header. If empty, the tool reuses chat-scoped `x-session-reader` cookies. Other settings are documented in `tool.manifest.json`.
