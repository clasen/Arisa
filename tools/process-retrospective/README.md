# process-retrospective

Schedules bounded, evidence-based reviews of recent Arisa operations.

The tool uses a lightweight recurring `poll_tool`. Each poll increments a chat-scoped pass counter and emits an `agent_event` asking Arisa to inspect recent outcomes. When telemetry samples exist, the review compares the current window with the immediately preceding baseline through `telemetry-ledger`; correlated dimensions remain hypotheses, not causal claims. The agent remains silent when there is no supported improvement and never applies a proposal automatically.

## Focus rotation

The default focus changes every four passes:

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
