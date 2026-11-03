# process-retrospective

Schedules bounded, evidence-based reviews of recent Arisa operations.

The tool uses a lightweight recurring `poll_tool`. Before emitting an `agent_event`, each poll checks bounded chat-scoped signals for new user corrections, failed or authentication-blocked tasks, and telemetry regressions. Unchanged polls stop without spending an agent turn; incomplete signal checks fail open, and a full review is forced at least once every 24 hours by default. Reasoned passes review the process generally across reliability, efficiency, output quality, and creative alternatives. Individual incidents provide evidence, but proposals are expressed as reusable process improvements rather than being tied to one campaign or tool.

When telemetry samples exist, the review compares the current window with the immediately preceding baseline through `telemetry-ledger`; correlated dimensions remain hypotheses, not causal claims. The agent remains silent only when there is no supported improvement. When evidence supports one or more improvements, it reports between one and the configured maximum. It never applies a proposal automatically.

## Focus rotation

The default primary lens changes every four passes, but it does not restrict the review's scope:

1. reliability and safety
2. efficiency and repetition
3. output quality and user corrections
4. creative alternatives and assumptions

After the fourth focus, the cycle repeats.

## Actions

- `start`: create the recurring poll
- `tick`: internal poll callback
- `status`: inspect state and the next focus
- `preview`: preview the next agent prompt
- `disable`: suppress future agent wake-ups from the active run

To remove a recurring poll completely, cancel its scheduled task through Arisa's task controls.

## State

Pass count, rotation state, bounded signal identifiers, gate counters, and last forced-review time are stored in the chat-scoped tool state directory. No request content, credentials, or retrospective evidence is copied into the tool state. Configure the gate with `GATE_ENABLED`, `FORCE_REVIEW_SECONDS`, and `SIGNAL_LOOKBACK_LIMIT`.
