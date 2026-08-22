# campaign-draft-runner

Runs recurring, profile-driven outreach research and creates Gmail drafts. It never sends email.

The tool can:

- reconcile manually sent Gmail messages with `pr-campaign` before each live cycle;
- select unused contacts from `pr-campaign`;
- discover public editorial contacts through `web-browser`, following same-site contact and staff links when result pages do not expose an address;
- reject previously used recipients and outlets;
- skip expensive unchanged empty batches while forcing bounded periodic reviews;
- verify email domains before drafting;
- research coverage on the contact's own site;
- render localized subject and body templates;
- replace legacy product copy with localized `factSheet.draftStatements` whose declared fact keys are present in the owner-approved fact sheet.

For profiles with a `factSheet`, drafting fails closed unless the selected language has `factSheet.draftStatements`. Each statement declares `factKeys`; every key must have an approved value before the statement can enter a Gmail draft. Greeting, grounded opening, closing, and signature remain localized, while all legacy product paragraphs are discarded.

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
    "agentDecidesEligibility": false,
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

When `TELEMETRY_ENABLED` is true and `telemetry-ledger` is installed, each run records business-operation latency, confirmed non-dry-run draft counts, and whether an unchanged batch was skipped. Telemetry is optional and fail-open: recording failures never change the campaign result. The integration emits only bounded aggregate dimensions such as profile, action, and status; it never records addresses, copy, or source content.

## Unchanged batch skipping

After a clean full run finds no eligible contacts, creates no drafts, and reports no discovery errors, the runner stores a SHA-256 fingerprint of the profile, campaign counters, Gmail draft recipients, discovery state, and approved fact state. A later live `run-batch` still performs incremental Sent reconciliation, then skips contact loading, web discovery, verification, research, and draft work when that fingerprint is unchanged.

State changes invalidate the fingerprint immediately. The default forced-review interval is six hours, bounded between 15 minutes and seven days, so external pages and same-count contact edits are eventually reconsidered. Set `UNCHANGED_BATCH_FORCE_MS` per chat, disable the feature with `UNCHANGED_BATCH_SKIP_ENABLED=false`, or use `forceReview=true` for one invocation. A profile may override the interval with `batchSkip.forceReviewAfterMinutes` or disable it with `batchSkip.enabled=false`.

Dry runs never use the skip. `untilDrafted` loops honor it because unchanged upstream state cannot produce a new result; use `forceReview=true` to bypass it. Runs with discovery errors or retryable selected contacts do not arm it. Skip state is chat/profile scoped and contains only a fingerprint, timestamps, aggregate counters, and a compact summary.

Use `action: "reconcile-sent"` to run the same synchronization without discovery or drafting. `gmail-workspace` paginates sent mail, fetches message metadata concurrently, and passes recipients, subjects, timestamps, and Gmail message IDs to `pr-campaign` in one batch.

`minEligiblePool` controls the unused-contact backlog. Keep recurring one-draft jobs bounded with small query and page budgets. A pool target of 1, one normal query, one creative query, three pages per mode, and a 15-second web timeout prevent long zero-yield cycles.

Set `selection.agentDecidesEligibility: true` when the calling agent reviews and adds contacts itself. In this mode, positive `includeKeywords` and `requiredKeywordGroups` do not reject agent-approved contacts, and the runner skips its own web discovery. Negative exclusions, email validation, source rules, prior-recipient checks, outlet deduplication, bounces, and opt-outs remain enforced.

Set `untilDrafted: "true"` on a non-dry run to retry discovery with rotating queries until at least one new draft is created. `retryDelaySeconds` controls the pause between attempts; `maxAttempts` and `maxRuntimeSeconds` bound the retry loop. The runner stops after one empty normal and creative discovery pass instead of repeating the same zero-yield work.

When the normal pass leaves no eligible candidates, `discovery.creativeDiscovery` provides a bounded fallback. It builds and rotates queries from comparable titles (`seeds`), adjacent audience ideas (`themes`), outlet types (`audiences`), contact intents, and templates. The fallback has its own persistent cursor, query budget, page budget, and optional URL cooldown, so repeated zero-result runs explore new combinations rather than repeating the same searches. Existing email verification, provenance, deduplication, exclusions, and draft-only safeguards still apply.

With `discovery.archiveEmptyQueries` enabled (the default), a completed query that yields no eligible contact is archived in chat-scoped discovery state and omitted from later rotations. Queries with search or page errors are not archived, so temporary provider failures remain retryable.

Profiles may define a dated, owner-bound `factSheet.fields` list for product claims. `facts-update` accepts only declared keys and records the approver and timestamp; `facts-status` returns approved facts separately from unresolved questions. Secretary and outreach workflows must use only `approvedFacts` and ask the owner instead of filling gaps. Facts are stored in the chat-scoped tool state, not in the installed package.

For agent-reviewed discovery, run the first search tranche with simple native-language competitor and coverage terms, then call `assess-search-quality` with `searches` as a JSON array (or its JSON-string form through Arisa): `[{ "query": "...", "text": "..." }]`. The action classifies noisy store, dictionary, reference, directory, and unrelated results; recommends either source-directed fallback or broader coverage expansion; and persists a five-cycle metrics window without storing raw search payloads. When quality is poor, remove contact terms, open credible coverage first, and spend the remaining search budget on the identified outlet, author, localized title, or source domain.

Before reopening known coverage or contact pages, call `sources-check` with their URLs. Record sources that are already used, lack a public editorial email, fail contact validation, duplicate prior work, or cannot be verified with `sources-record`. Records contain only canonical URL, bounded reason, and timestamps; they expire after 30 days so changed contact pages can be revalidated. `sources-status` returns the compact active ledger.

Research source URLs are omitted from personalized openings by default so outreach contains only the campaign link. Set `personalization.includeSourceUrl: true` only when a profile explicitly needs the source URL in the email.

For reviewer-first workflows, store separate `coverageSourceUrl` and `contactSourceUrl` values on each contact. `coverageTitle`, `groundedOpening`, and an explicit `language` let the runner render the exact evidence already approved by the agent instead of trying to rediscover it. The legacy `sourceUrl` field remains an alias for `coverageSourceUrl`.

Profiles can enforce these fields with `selection.requireCoverageSourceProvenance`, `selection.requireContactSourceProvenance`, and `selection.requireGroundedOpening`. A `draftValidation` block can independently require both sources, coverage-title metadata, and the grounded opening before Gmail draft creation. The title may be paraphrased in the draft; the grounded opening must still be rendered. `draftValidation.canonicalUrls` normalizes campaign links before the preflight. Failed preflights are reported as skipped contacts and do not create a draft.

Nested read-only calls that time out return `timed_out` with a retry-safe resolution. Mutating calls return `outcome_uncertain` and require a status check instead of an automatic retry.
