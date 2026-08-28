# Lightpanda limit suite

Generated: 2026-08-28T18:23:31.756Z

This Lightpanda-only suite uses fixture-specific semantic assertions. HTTP success or non-empty output never counts by itself. Chromium is not launched. Compatibility failures are recorded as explicit limits rather than hidden by fallback.

| Category | Fixture | Semantic result | Latency (ms) |
|---|---|---:|---:|
| react | react-todomvc | pass | 729 |
| vue | vue-todomvc | pass | 200 |
| angular | angular-todomvc | pass | 288 |
| forms | public-form | pass | 422 |
| modals | css-modal | pass | 1339 |
| tables | html-table | pass | 994 |
| scrolling | long-news-page | pass | 364 |
| redirects | public-redirect | pass | 98 |
| iframes | html-iframe | pass | 1002 |

## Bounded probes

- 100-navigation probe: **completed**, 100/100, peak 24 MiB, median growth 0.1 MiB.
- Concurrent sessions: **pass**, 2 sessions, aggregate peak 62.3 MiB, swap growth 11.5 MiB.
- Unsupported API fixture: **unsupported** — One or more subtests produced no duration.
- Forced timeout and clean recovery: **pass**.
- Unexpected residual Lightpanda processes: **0**.
