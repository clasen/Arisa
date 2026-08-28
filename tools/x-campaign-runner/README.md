# x-campaign-runner

Runs evidence-backed, profile-driven organic outreach on X while keeping `x-dm` as the low-level transport and safety boundary.

## Workflow

1. `discover` rotates standard queries, then creative queries when necessary. It uses authenticated X post and people search first, strips web-only `site:x.com` operators from native queries, and falls back to bounded structured `lightpanda-browser` search only when X yields no accepted candidate. Every prospect retains its public source, query, snippet, score, and discovery time.
2. `prepare-next` excludes all prior X DM recipients, ranks candidates, verifies that the profile exposes a real DM composer, renders deterministic copy from evidence, and persists one expiring approval. It never sends.
3. The user reviews the exact candidate and message.
4. `send-approved` requires the persisted `approvalId`, exact `messageHash`, unchanged profile digest, `confirm=true`, and `dryRun=false`. When `follow.enabled` is true, it first asks `x-dm` to verify or create the target follow and persists that result before attempting the DM. A failed or uncertain follow blocks the DM.
5. `skip` rejects the pending approval so another candidate can be prepared. If only the greeting is malformed, `revise-greeting` accepts a name grounded in the verified target identity and persists fresh exact copy, hash, idempotency key, and approval ID before any send.
6. `reconcile` converts a manual-review approval to sent only when verified matching `x-dm` history exists; `assume-sent` records an explicitly accepted uncertain delivery without retrying. Profiles may set `uncertainDeliveryPolicy` to `assume-sent`.

There is no batch-send or autonomous scheduled-send action. `x-dm` independently enforces account pinning, locking, a durable recipient index, idempotency, cooldown, daily caps, delivery verification, and manual review for uncertain outcomes.

## Profile location

```text
<chatToolStateDir>/profiles/<profile>.json
```

Profiles contain campaign-specific queries, creative queries, selection rules, optional evidence-backed seed prospects, templates, budgets, approval TTL, `message.greetingMode`, and optional follow-before-send policy. Use `first-name` when the campaign requires a verified personal first name; use `display-name` to accept the target-bound X display identity without that restriction. Credentials stay in `x-dm` or other transport tools.

## Examples

Prepare one proposal:

```json
{"args":{"action":"prepare-next","profile":"castle-bravo","maxChecks":"4"}}
```

Send exactly the persisted proposal after reviewing it:

```json
{
  "args": {
    "action": "send-approved",
    "profile": "castle-bravo",
    "approvalId": "<persisted-id>",
    "messageHash": "<persisted-sha256>",
    "confirm": "true",
    "dryRun": "false"
  }
}
```
