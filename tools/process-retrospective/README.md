# process-retrospective

Schedules bounded, evidence-based reviews of recent Arisa operations.

The tool uses a lightweight recurring `poll_tool`. Each poll increments a chat-scoped pass counter and emits an `agent_event` asking Arisa to inspect recent outcomes. Every pass reviews the process generally across reliability, efficiency, output quality, and creative alternatives. Individual incidents provide evidence, but proposals are expressed as reusable process improvements rather than being tied to one campaign or tool.

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

Pass count and rotation state are stored in the chat-scoped tool state directory. No request content, credentials, or retrospective evidence is copied into the tool state.
