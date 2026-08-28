# Lightpanda browser benchmark

Generated: 2026-08-28T15:35:28.140Z

> Historical result: this run used the former non-empty-output success rule. Version 0.4 now requires fixture-specific semantic content, so the success counts below must not be treated as current semantic pass rates.

This is a bounded directional benchmark: three anonymous public HTTPS pages, one run per engine and page. Network variance means the latency values are not a durable performance claim. Peak RSS is the sampled process-tree resident set, not heap. Medians include failed and timed-out attempts so resource cost is not hidden.

| Engine | Success | Median observed latency (ms) | Median observed peak RSS (MiB) |
|---|---:|---:|---:|
| web-browser | 3/3 | 3040 | 60.7 |
| lightpanda | 3/3 | 1492.9 | 21.3 |
| chromium | 0/3 | 30335.6 | 733.8 |

## Switching guidance

1. Use `web-browser` first for search and static/readable pages; it has no rendering engine.
2. Use `lightpanda-browser` for anonymous public pages that require JavaScript or rendered-DOM extraction.
3. Select Chromium explicitly for authenticated sessions, unsupported browser APIs, visual fidelity, downloads, CAPTCHA, or payment authentication.
4. A Lightpanda compatibility failure never triggers Chromium automatically.
5. Keep browser outputs bounded because the active Pi session, not browser subprocess RSS, caused the observed worker OOM.

Raw bounded results are stored in `benchmark-latest.json`.
