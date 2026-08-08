# x-dm

Audits X/Twitter outreach history, validates whether a target accepts DMs, and sends one explicitly approved DM at a time through a user-provided X web session.

It does not bypass login, CAPTCHAs, recipient restrictions, rate limits, or other X safeguards. Because browser automation can put an account at risk, use conservative caps and review every message before sending.

## Actions

- `audit`: summarize recorded sends, recipients, campaigns, uncertain deliveries, unresolved attempts, and recent attempts without opening X.
- `status`: validate the logged-in X account and include campaign health.
- `check`: open one profile and report whether the DM button is visible; `verifyComposer=true` confirms that the conversation composer actually opens without typing.
- `search`: read a bounded set of visible X post or people results without sending.
- `verify-delivery`: read back an approved message from a target conversation to reconcile an uncertain send without retrying it.
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

- Browser sessions are ephemeral; cookies are loaded into a fresh context for each action.
- A bounded operation deadline and absolute process watchdog prevent permanent browser hangs.
- A chat-scoped lock serializes state-changing work.
- State writes are atomic and malformed state fails closed.
- Confirmed sends reserve an idempotency key before clicking.
- Duplicate recipients, unresolved attempts, cooldown, global and per-campaign daily caps, and a short failure circuit breaker block unsafe retries.
- The tool clicks only an explicit DM send button. It does not use keyboard fallbacks.
- Success is recorded only when the composer clears and the approved message appears in the conversation. Otherwise the attempt is marked uncertain and retries are blocked. `verify-delivery` may reconcile it later by readback, but never resends.
- `EXPECTED_ACCOUNT_HANDLE` can pin the permitted sending account.

Legacy entries created before state version 2 remain visible as campaign `legacy`; they are historical send claims rather than cryptographically verified X delivery receipts.

## Config

`X_COOKIES` may be a JSON cookie array, Netscape cookies file, or raw Cookie header. If empty, the tool reuses chat-scoped `x-session-reader` cookies. Other settings are documented in `tool.manifest.json`.
