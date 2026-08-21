# telemetry-ledger

A chat-scoped operational telemetry ledger for Arisa. It stores bounded numeric measurements, summarizes metrics, compares adjacent time windows, and identifies correlated dimensions as hypotheses—not proven causes.

## Integration contract

Producers measure their own operation and batch records after the outcome is known. This avoids adding telemetry overhead to the measured latency and keeps mutation uncertainty in the producer.

```js
await arisa.tools.run({
  name: "telemetry-ledger",
  args: {
    action: "record",
    records: JSON.stringify([
      { metric: "tool.latency_ms", kind: "duration", value: elapsedMs, unit: "ms", source: "campaign-draft-runner", dimensions: { tool: "gmail-workspace", action: "draft", status: "ok" } },
      { metric: "gmail.drafts.created", kind: "counter", value: 1, unit: "draft", source: "campaign-draft-runner", dimensions: { campaign: "castle-bravo" } }
    ])
  }
}, { timeoutMs: 10000 });
```

Telemetry failures must never change the producer's business outcome. Do not record message bodies, email addresses, credentials, or other high-cardinality/private payloads.

## Analysis

Define metric direction first (`lower`, `higher`, or `neutral`), then compare adjacent windows. Classification requires a minimum sample count. Dimension breakdowns are reported as correlations only.

`compare` and `report` return compact decision evidence by default so routine analysis does not duplicate large nested summaries into agent context. Pass `verbose: true` only for explicit diagnostics that need every aggregate field.
