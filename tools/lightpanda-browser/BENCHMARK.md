# Lightpanda browser benchmark

Generated: 2026-08-28T23:17:59.777Z

This is a bounded directional benchmark: three anonymous public HTTPS pages, one run per engine and page. Success requires fixture-specific semantic content, not merely HTTP 200 or non-empty output. Network variance means the latency values are not a durable performance claim. Peak RSS is the sampled process-tree resident set, not heap. Medians include failed and timed-out attempts so resource cost is not hidden.

| Engine | Success | Median observed latency (ms) | Median observed peak RSS (MiB) |
|---|---:|---:|---:|
| lightpanda | 3/3 | 1647.5 | 22.5 |
| chromium | 0/0 | n/a | n/a |

## Switching guidance

1. Use `lightpanda-browser` for anonymous public pages, including JavaScript and rendered-DOM extraction.
2. Select Chromium explicitly for authenticated sessions, unsupported browser APIs, visual fidelity, downloads, CAPTCHA, or payment authentication.
3. A Lightpanda compatibility failure never triggers Chromium automatically.
4. Keep browser outputs bounded because active Pi tool results can raise worker heap usage.

Raw bounded results are stored in `benchmark-latest.json`.
