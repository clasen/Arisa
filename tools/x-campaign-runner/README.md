# x-campaign-runner

Runs evidence-backed, profile-driven organic outreach on X while keeping `x-dm` as the low-level transport and safety boundary.

## Workflow

1. `discover` rotates standard queries, then creative queries when necessary. It can use authenticated X search, the registered `web-browser`, and a bounded DuckDuckGo HTML fallback. Every prospect retains its public source, query, snippet, score, and discovery time.
2. `prepare-next` excludes all prior X DM recipients, ranks candidates, verifies that the profile exposes a real DM composer, renders deterministic copy from evidence, and persists one expiring approval. It never sends.
3. The user reviews the exact candidate and message.
4. `send-approved` requires the persisted `approvalId`, exact `messageHash`, unchanged profile digest, `confirm=true`, and `dryRun=false`. It calls `x-dm` exactly once.
5. `skip` rejects the pending approval so another candidate can be prepared.

There is no batch-send or autonomous scheduled-send action. `x-dm` independently enforces account pinning, locking, a durable recipient index, idempotency, cooldown, daily caps, delivery verification, and manual review for uncertain outcomes.

## Profile location

```text
<chatToolStateDir>/profiles/<profile>.json
```

Profiles contain campaign-specific queries, creative queries, selection rules, optional evidence-backed seed prospects, templates, budgets, and approval TTL. Credentials stay in `x-dm` or other transport tools.

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
