# change-plan-runner

`change-plan-runner` turns one explicitly approved workspace plan into sequential agent batches. It coordinates and gates progress; it does not edit files or execute arbitrary commands from plan text.

Git is optional. A user can orchestrate work in a normal directory on a machine without Git installed.

## Workflow

1. `create` validates the workspace directory and persists a bounded plan.
2. `start` records plan-level approval and schedules only the first batch.
3. The scheduled agent calls `begin` before changing the workspace.
4. The agent completes the batch and runs its declared checks.
5. `complete` verifies named evidence and any enabled Git boundaries.
6. Only then is the next batch scheduled.
7. `block` stops progression. `resume` retries the same batch; it never skips ahead.

One active plan is stored per chat under the standard chat-scoped tool state directory.

## Git modes

- `auto` (default): use Git metadata when the workspace belongs to a repository; otherwise continue without Git.
- `required`: refuse to create or advance the plan unless Git and a repository are available.
- `disabled`: never invoke Git.

Clean-tree, commit, and push gates are independent options and apply only when Git is enabled. They default to false, so general plans do not acquire repository requirements accidentally.

## Actions

- `create`: `args.plan` contains `title`, absolute `workspace`, optional `policy`, and `batches`. Legacy `repository` remains accepted.
- `start`: records approval and dispatches the first batch.
- `status`: returns the active plan summary.
- `begin`: requires `planId` and `batchId`.
- `complete`: requires `planId`, `batchId`, and `evidence`.
- `block`: requires `planId`, `batchId`, and `reason`.
- `resume`: retries a blocked batch.
- `cancel`: terminates an active plan.

Each batch supports:

```json
{
  "id": "contract",
  "title": "Define the tool contract",
  "objective": "Specify inputs, outputs, and safety boundaries.",
  "instructions": "Keep user-facing help in English.",
  "checks": ["contract reviewed"],
  "afterComplete": "Report the accepted contract."
}
```

`checks` are exact evidence keys. A successful completion must report each key as `"passed"`.

## Safety properties

- Creating a plan never starts it.
- Plan-level approval and execution are separate actions.
- Exactly one batch can be active.
- The next task is emitted only after successful completion gates.
- Failed or uncertain work blocks instead of advancing.
- Plan text is never run as shell input by the tool.
- Optional Git verification uses fixed read-only commands.
- State writes are serialized and atomic.
