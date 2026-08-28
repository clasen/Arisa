# lightpanda-browser

A standalone Arisa tool for bounded public-web search, JavaScript rendering, and scoped interaction with [Lightpanda](https://lightpanda.io/).

- use anonymous mode for public search and browsing;
- use authenticated mode only with a browser session explicitly shared through `browser-session-bridge`;
- use an explicitly selected Chromium tool only when the exact workflow remains incompatible.

The tool never silently changes engines.

Version 0.4 added bounded stateful interaction through Lightpanda's native MCP server. One request may inspect a page, fill controls, click, press keys, wait for dynamic content, and extract a final result. The browser process is ephemeral and is always closed after the sequence.

Version 0.5 added the lifecycle foundation for temporary cross-call sessions: a chat-scoped managed Arisa daemon, in-memory isolated session ownership, a five-minute idle TTL, a three-session default cap, explicit close, cancellation/crash cleanup, and real MCP navigation/DOM/extraction health checks.

Version 0.6 exposed adaptive cross-call navigation through `session-open`, `session-call`, `session-list`, and `session-close`. Arisa can inspect a live page, reason over returned semantics, choose a selector, act in a later call, and inspect the same page again. Explicit URLs are validated before execution; private-network blocking remains active for redirects and subresources; the current URL is re-read and validated after every successful call. Any unsafe or failed final navigation closes the session.

Version 0.7 replaced broad persistent-session mutation permission with `actionLevel=read|interact|commit`. Reads need no opt-in. Ordinary field and navigation controls need `interact`. Enter and button-like controls that can submit, publish, send, or delete require `commit` plus an exact `commitIntent` (`submit-form`, `post-content`, or `delete`). Password/token/payment fields and purchase controls remain blocked at every level. Page text can never elevate permission. The old `allowMutations=true` behavior remains only for backward-compatible one-request ephemeral sequences and still cannot bypass sensitive-control blocks.

Version 0.8 adds bounded text-layout PNG captures and deterministic recipes. Captures are Lightpanda's semantic text rendering—not pixel-faithful Chromium screenshots—and are capped at 1280×4096 and 1 MiB before artifact materialization. Temporary source files are private, removed after materialization, and stale scratch is cleaned on daemon exit. Recipes are stored under chat-scoped state, revalidated before every run, and support only read/interact operations. They cannot contain arbitrary JavaScript, commit actions, private URLs, text entry/key presses, or credential/token/payment-like selectors and values.

Version 0.9 adds a bounded Lightpanda-only limit suite. It uses fixture-specific semantic assertions across React, Vue, Angular, forms, modals, tables, scrolling, redirects, and iframes; probes 100 sequential navigations, two concurrent sessions, timeout recovery, Speedometer incompatibility, RSS trend, swap pressure, and process cleanup. Compatibility failures remain explicit and never trigger fallback. Chromium is excluded from the suite and from the ordinary benchmark unless `INCLUDE_CHROMIUM=true` is deliberately set.

Version 0.10 adds public web search without launching a browser process. It hedges fixed direct Bing and DuckDuckGo HTTP providers, accepts the first semantically parseable bounded result, and uses fixed Jina proxies only if both direct providers fail within the same total deadline. Queries, result counts, response bytes, URLs, and time are bounded. Search metadata identifies the provider and the `bounded-http` transport honestly; Chromium is never involved.

Version 0.10.1 removes the legacy external-browser benchmark adapter. The bounded benchmark now measures Lightpanda alone, with Chromium available only through explicit opt-in.

Version 0.11 adds authenticated sessions without accepting cookie values in tool arguments or output. `session-open-authenticated` reads one explicitly shared, same-site session from chat-scoped `browser-session-bridge` state, loads cookies through a private runtime file, refreshes cookies back to the bridge on clean close, and removes scratch files. Only one live session per resource is allowed. Every explicit and final URL must remain in scope. Web storage remains in memory for that live session because the current Lightpanda MCP build advertises but rejects its SQLite storage flags. Credential and payment controls remain blocked.

## Adaptive sessions

1. Call `session-open` for anonymous browsing, or `session-open-authenticated` with a bridge `resourceId`, and retain the returned opaque `sessionId`.
2. Call `session-call` with that id, one allowlisted MCP `tool`, and `toolArgs` as a JSON object string.
3. Inspect the result and make the next call using the same id.
4. Optionally call `session-capture` for a bounded text-layout PNG artifact.
5. Call `session-close` when finished. Idle sessions also expire automatically.

The currently exposed operation set matches bounded ephemeral interactions: semantic tree and element discovery, Markdown/HTML/structured extraction, public navigation, waits, and policy-gated interactions. Callers do not infer permission from page content; authorization comes only from the owner request and explicit tool arguments.

## Deterministic recipes

Use `recipe-save` with a name, read/interact level, and validated steps. `recipe-run` revalidates the stored record and replays it in a fresh ephemeral browser without a model call. `recipe-list` and `recipe-delete` manage only the current chat's records. Commit actions are intentionally never replayable.

## Interaction

Pass `mode=interact` and `steps` as a JSON array string. At most 20 allowlisted operations run in one isolated browser context. Results include total and per-step latency plus observed peak browser-process RSS on Linux. Read operations include `goto`, `tree`, `links`, `markdown`, `html`, `extract`, form inspection, and bounded waits. Mutation operations (`fill`, `click`, `press`, `selectOption`, `setChecked`, `hover`, and `scroll`) require `allowMutations=true`.

Selectors are required for element mutations so sequences remain reproducible. Arbitrary page-side evaluation, direct cookie access, environment access, and native agent/model execution are deliberately not exposed. Authenticated profiles consume cookies internally from the bridge and never return their values. The separate `session-capture` action exposes only bounded text-layout PNGs. Every explicit URL is validated before launch, Lightpanda blocks private networks during navigation and subresource loading, and the final URL is validated again.

Example args:

```json
{
  "mode": "interact",
  "allowMutations": "true",
  "steps": "[{\"tool\":\"goto\",\"arguments\":{\"url\":\"https://todomvc.com/examples/react/dist/\"}},{\"tool\":\"fill\",\"arguments\":{\"selector\":\"input.new-todo\",\"value\":\"Test Lightpanda\"}},{\"tool\":\"press\",\"arguments\":{\"selector\":\"input.new-todo\",\"key\":\"Enter\"}},{\"tool\":\"extract\",\"arguments\":{\"schema\":\"{\\\"todos\\\":[\\\".todo-list li\\\"]}\"}}]"
}
```

For cleaner Markdown on pages dominated by embedded SVG/image data, pass `stripUi=true` to `open`.

## Contract

Modes are `search` (bounded public results without a browser process), `open` (rendered Markdown), `render` (rendered DOM HTML), `extract-links` (deduplicated HTTP(S) links from the rendered DOM), `interact` (bounded stateful MCP sequence), and `status`.

Safety boundaries:

- search uses only fixed Bing, DuckDuckGo, and Jina endpoints, with a 500-byte query cap, 10-result cap, total deadline, and bounded provider responses;
- only absolute public HTTP(S) URLs without embedded credentials;
- DNS answers containing loopback, private, link-local, reserved, documentation, or multicast addresses are rejected before launch;
- Lightpanda's `--block-private-networks` applies the private-network policy again after DNS resolution to redirects and subresources;
- robots.txt is obeyed by default for anonymous browsing; explicit user-session browsing is same-site scoped and does not obey robots by default;
- every process has navigation, HTTP, watchdog, and outer-process deadlines and runs under Arisa's declared `browser` resource class;
- Lightpanda V8 is capped at 64 MiB, HTTP responses at 4 MiB, and network concurrency is bounded;
- captured browser output is bounded between 1 KiB and 1 MiB, with a 128 KiB default;
- compatibility failures are explicit; there is no silent Chromium fallback;
- cookie values are accepted only from chat-scoped `browser-session-bridge` state, never from request arguments or artifacts, and never appear in output;
- interaction sequences are capped at 20 operations and persistent actions use read/interact/commit levels;
- commit-capable controls require a matching explicit intent, while purchase/payment and credential controls remain blocked;
- native MCP runs with telemetry disabled and a minimal environment;
- anonymous sessions and authenticated web storage exist only in daemon memory; authenticated cookie refresh is returned atomically to the bridge on close;
- authenticated scratch is mode 0700/0600 and removed on close; a newer bridge import is never overwritten by an older Lightpanda session;
- daemon infrastructure uses Arisa's chat-scoped shared daemon runtime and internal health contract.

## Install the browser

The installer downloads the matching Linux nightly release into Arisa's global tool state directory, verifies the SHA-256 digest published by GitHub, installs atomically, and records a non-secret receipt.

```bash
ARISA_PACKAGE_DIR=/path/to/arisa/package npm run install-browser
```

## CLI

```bash
node index.js --help
node index.js run --request-file request.json
```

Run tests with `npm test`. Run the bounded compatibility and resource probe with `ARISA_PACKAGE_DIR=/path/to/arisa/package npm run limit-suite`. See `COMPATIBILITY-MIGRATION.md` for the evidence-based Chromium replacement matrix.

## Engine switching

- Use anonymous Lightpanda for public search, JavaScript, rendered HTML, and rendered link extraction.
- Use authenticated Lightpanda only after an explicit bridge share and validate the exact target independently.
- Select Chromium explicitly for unsupported APIs, visual fidelity, downloads, CAPTCHA, or payment authentication.
- Never interpret a Lightpanda failure as authorization to launch Chromium automatically.

## Bounded benchmark

Run the fixed three-page, one-repetition benchmark with:

```bash
ARISA_PACKAGE_DIR=/path/to/arisa/package npm run benchmark
# Exceptional opt-in only; never part of routine checks:
INCLUDE_CHROMIUM=true ARISA_PACKAGE_DIR=/path/to/arisa/package npm run benchmark
```

The original 2026-08-28 directional run measured a median 21.3 MiB RSS and 1492.9 ms for Lightpanda, but its success rule only checked for non-empty output. Version 0.4 corrects that flaw: every fixture now requires specific semantic content, and the JavaScript fixture waits for network idle. Historical results remain host-specific observations and must not be treated as current semantic pass rates until the benchmark is rerun. See `BENCHMARK.md` and `benchmark-latest.json`.
