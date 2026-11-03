# Catalog updates — 2026-11-03

Source-only release of reviewed local improvements. Installed tools and running daemons are not changed by this commit.

| Tool | Catalog version | Changes |
| --- | --- | --- |
| arca-invoice | 0.3.0 | Identified final consumers using validated CUIT and name; recipient-aware PDF and reconciliation. Exact approval and durable no-retry issuance remain required. |
| browser-session-bridge | 0.2.7 | Bounded Google/YouTube cookie permissions, Google session merge policy, Chrome Web Store workflow helpers and optional YouTube transcript extraction. Package version 1.4.7 and extension version 1.4.5 retain their existing separate version tracks. |
| campaign-draft-runner | 0.9.0 | Draft-one orchestration, candidate promotion, stricter coverage and draft limits, authentication prerequisite handling and complete unchanged-state fingerprints. No email sending. |
| context-vault | 1.2.3 | Optional lexical-only operation without loading the semantic embedding model. Semantic mode remains enabled by default. |
| creator-scout | 1.4.1 | Structured authentication blocks and bounded hydration-aware session verification. |
| github-ops | 1.1.0 | Exact-repository invitations, chat-scoped authenticated checkout and clean fast-forward synchronization. |
| gmail-workspace | 0.1.3 | Structured terminal authentication errors with recovery guidance. |
| lightpanda-browser | 0.11.6 | On-demand daemon startup rather than automatic restart after idle shutdown. |
| process-retrospective | 1.3.0 | Bounded signal gate for unchanged polls, with forced daily review and fail-open behavior for incomplete signals. |
| roster-sites | 1.1.0 | Static releases and rollback, assets, root text, audio routing and bilingual story publication helpers. Story-pair/index helpers remain explicitly restricted to arisa.sh; they are not generic CMS operations. |
| schedule-agent-task | 1.1.0 | Versioned appointment records with route/time protection and cancellation. |
| whatsapp-web | 1.4.0 | Quoted-message context, wake-up for replies to the bot and exact-group picture updates. Existing media compatibility fix retained. |
| x-session-reader | 1.2.1 | Correct browser-session-bridge dependency range for the current 0.2 series. |

## Validation and exclusions

- 265 tests passed; one browser bridge test skipped. No failing tests. Tests ran against the staged source with existing local dependencies; a fresh dependency installation was not tested.
- CLI help passed for all 13 tools. GitHub operations have no automated behavioral suite in this release; their help and JavaScript syntax were checked only.
- No live invoice issuance, email sending, browser-store submission, WhatsApp messaging or deployment was performed for this release. Offline invoice tests are not ARCA homologation.
- Private configuration, credentials, sessions, databases, runtime files, node_modules and project-specific deployment helpers are excluded.
- Catalog dependency upgrades were preserved; older local dependency versions were not copied back. Local-only tools are outside this release.
- No npm release is included.
