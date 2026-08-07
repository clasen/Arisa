# campaign-draft-runner

Runs recurring, profile-driven outreach research and creates Gmail drafts. It never sends email.

The tool can:

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
    "minEligiblePool": 3,
    "queriesPerRun": 2,
    "maxResults": 6,
    "queries": ["topic publication editor contact"]
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

Use `action: "status"` to inspect campaign and Gmail draft counts. `minEligiblePool` asks discovery to maintain a backlog of unused, eligible contacts so recurring one-draft runs do not depend on finding a new contact during every interval.

Set `untilDrafted: "true"` on a non-dry run to retry discovery with rotating queries until at least one new draft is created. `retryDelaySeconds` controls the pause between attempts; `maxAttempts` and `maxRuntimeSeconds` keep the retry loop bounded.
