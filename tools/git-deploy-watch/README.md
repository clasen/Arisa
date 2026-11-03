# git-deploy-watch

Chat-scoped public Git branch watcher with no npm dependencies.
Requires Node.js, Git and the `flock` command (util-linux); the current lock
implementation is not supported on Windows without a compatible environment. It uses read-only
`git ls-remote` checks and Arisa's persistent recurring `poll_tool` tasks.
New revisions emit one domain-bound `agent_event` for an owner-approved deployment
workflow. Unchanged checks spend no reasoning turns. No custom daemon or cron is needed.

## Setup

Use chat-scoped tool configuration, not the generic `config.js` defaults:

- `REPO_URL`: credential-free public HTTPS Git URL.
- `BRANCH`: exact branch (`master` by default).
- `DOMAIN`: exact deployment domain.
- `WORKFLOW`: approved checkout/build/validation/deployment/verification/rollback steps.
- `CHECK_SECONDS`: 300 by default, bounded to 60–86400.

Run `watch` with `confirm=true` and the full SHA of the revision already deployed and
verified at the destination. Enable only with explicit owner approval. Git alone does not
prove that a deployment is current. Never initialize the deployed cursor from remote HEAD
without verifying the destination first.

## Agent delivery contract

1. A changed SHA queues one event. `claim` must succeed for the exact SHA and generation
   before work starts. It returns a one-time token and the configured approved workflow.
2. The agent handles checkout, build, validation, artifact creation, publication and real
   destination verification. It must preserve local changes and refuse diverged Git history.
3. Use `finish` with the detected SHA, claim token, actual outcome, bounded evidence and
   actual `deployedRevision` (the built SHA). Only then does the deployed cursor advance.
4. New remote commits coalesce while a deployment is pending. The next check picks up
   the newest head after acknowledgement. The checker does not run project scripts itself.

Failed SHAs are not retried until a different SHA arrives or `retry` is explicitly confirmed.
Uncertain outcomes block every new deployment until manual reconciliation. Pending claims
survive restart and never expire into an automatic duplicate. A claim pending for at least
30 minutes emits one domain-bound reconciliation alert on a successful poll. The agent
must recheck status and ignore alerts whose claim already finished. This does not expire
or retry the claim; live work and uncertain outcomes still require manual reconciliation.
New claims record their start time; legacy claims use their queue time. `pause` invalidates queued
claims and cancels the stored poll; it cannot undo work already claimed. Configuration
changes require pause and new approval. A watch scheduling timeout is uncertain: inspect
scheduled tasks before another attempt.

State and lock ownership live under `getChatToolStateDir(chatId, 'git-deploy-watch')`.
An OS-owned `flock` serializes writers and is released when its holder exits.
Legacy writer locks are removed only when their recorded PID no longer exists;
live, malformed or unverifiable ownership fails closed. Never unlink `state.flock`. This tool does not publish npm, push Git, handle wallet secrets or transact.

## Tests

`npm test` or `node --test` (no dependencies to install).

Deployment validation is project-specific and must be included in the approved
`WORKFLOW`. No project-specific browser helper, checkout, credentials or live state
ships with this tool. Tests use synthetic state and mocked remote checks; they do
not prove that a configured build or deployment succeeds.
