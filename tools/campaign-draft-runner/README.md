# campaign-draft-runner

Runs recurring, profile-driven outreach research and creates Gmail drafts. It never sends email.

The tool can:

- reconcile manually sent Gmail messages with `pr-campaign` before each live cycle;
- select unused contacts from `pr-campaign`;
- discover public editorial contacts through `web-browser`, following same-site contact and staff links when result pages do not expose an address;
- reject previously used recipients and outlets;
- verify email domains before drafting;
- research coverage on the contact's own site;
- render localized subject and body templates.

## Dependencies

Install and configure these Arisa tools:

- `pr-campaign`
- `gmail-workspace`
- `web-browser` when discovery or personalization is enabled

## Profile location

Profiles contain campaign-specific search terms and copy. Keep them in chat-scoped runtime state, not in this package or a Git repository:

```text
<chatToolStateDir>/profiles/<profile>.json
```

Minimal profile structure:

```json
{
  "name": "example",
  "campaignTool": "pr-campaign",
  "gmailTool": "gmail-workspace",
  "contactStatus": "new",
  "draftType": "first",
  "sentReconciliation": {
    "enabled": true,
    "query": "in:sent \"Campaign name\"",
    "initialMaxResults": 2000,
    "incrementalMaxResults": 500
  },
  "selection": {
    "includeKeywords": ["topic"],
    "excludeKeywords": ["advertising", "jobs"],
    "dedupeByOutlet": true,
    "skipOutletsAlreadyUsed": true
  },
  "defaultLanguage": "en",
  "discovery": {
    "enabled": true,
    "webTool": "web-browser",
    "minEligiblePool": 1,
    "archiveEmptyQueries": true,
    "queryBudgetPerRun": 1,
    "pageBudgetPerRun": 3,
    "timeoutMs": 15000,
    "maxResults": 6,
    "queries": ["topic publication editor contact"],
    "creativeDiscovery": {
      "enabled": true,
      "queryBudgetPerRun": 1,
      "pageBudgetPerRun": 3,
      "seeds": ["Comparable title"],
      "themes": ["adjacent audience theme"],
      "audiences": ["reviewer", "YouTube creator"],
      "contactIntents": ["contact email"],
      "templates": ["\"{{seed}}\" review {{audience}} {{contact}}"]
    }
  },
  "personalization": {
    "enabled": true,
    "webTool": "web-browser",
    "querySuffix": "review OR feature",
    "openingTemplates": {
      "en": "I read your piece “{{title}}”: {{url}}"
    }
  },
  "templates": {
    "en": {
      "subject": "A story for {{outlet}}",
      "body": "Hi {{outlet}},\n\nA short relevant opening.\n\nCampaign copy.\n\nSender"
    }
  }
}
```

## Run

```json
{
  "chatId": "<chat-id>",
  "args": {
    "action": "run-batch",
    "profile": "example",
    "limit": "1",
    "dryRun": "false"
  }
}
```

Use `action: "status"` to reconcile Gmail Sent, then inspect campaign and Gmail draft counts. The first reconciliation scans the configured sent-mail query. Later runs use the newest Gmail timestamp and persist message IDs in chat-scoped state. This records drafts sent manually as contacted without reopening them or changing terminal statuses such as bounced, opted-out, wrong-fit, and successful publication.

Use `action: "reconcile-sent"` to run the same synchronization without discovery or drafting. `gmail-workspace` paginates sent mail, fetches message metadata concurrently, and passes recipients, subjects, timestamps, and Gmail message IDs to `pr-campaign` in one batch.

`minEligiblePool` controls the unused-contact backlog. Keep recurring one-draft jobs bounded with small query and page budgets. A pool target of 1, one normal query, one creative query, three pages per mode, and a 15-second web timeout prevent long zero-yield cycles.

Set `untilDrafted: "true"` on a non-dry run to retry discovery with rotating queries until at least one new draft is created. `retryDelaySeconds` controls the pause between attempts; `maxAttempts` and `maxRuntimeSeconds` bound the retry loop. The runner stops after one empty normal and creative discovery pass instead of repeating the same zero-yield work.

When the normal pass leaves no eligible candidates, `discovery.creativeDiscovery` provides a bounded fallback. It builds and rotates queries from comparable titles (`seeds`), adjacent audience ideas (`themes`), outlet types (`audiences`), contact intents, and templates. The fallback has its own persistent cursor, query budget, page budget, and optional URL cooldown, so repeated zero-result runs explore new combinations rather than repeating the same searches. Existing email verification, provenance, deduplication, exclusions, and draft-only safeguards still apply.

With `discovery.archiveEmptyQueries` enabled (the default), a completed query that yields no eligible contact is archived in chat-scoped discovery state and omitted from later rotations. Queries with search or page errors are not archived, so temporary provider failures remain retryable.

Research source URLs are omitted from personalized openings by default so outreach contains only the campaign link. Set `personalization.includeSourceUrl: true` only when a profile explicitly needs the source URL in the email.
