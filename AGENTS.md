# Arisa AGENTS

## Architecture
- Telegram transport handles inbound and outbound messaging.
- Pi Agent keeps one session per authorized chat.
- Incoming messages and files (text, voice, photo, document) and generated files become artifacts.
- A tool registry handles tool discovery, help lookup, config writes, and execution.
- Tools are isolated and each one has its own manifest, entrypoint, and config defaults.

## Runtime directory rules
Do not build runtime paths by hand. Use `src/runtime/paths.js`:
- `getToolDir(toolName)`: installed user tool package only; no runtime data here.
- `getToolStateDir(toolName)`: global tool infrastructure only: daemons, queues, shared browser sessions, model caches.
- `getChatToolStateDir(chatId, toolName)`: persistent user/chat data: tool DBs, indexes, inboxes, generated sites, vaults.
- `getChatArtifactsDir(chatId)` / `getChatArtifactsIndexFile(chatId)`: chat artifacts and artifact index. Artifacts are never global.
- `getChatToolConfigPath(chatId, toolName)`: chat-scoped config overrides.
- `getToolTmpDir(toolName)` / `getChatToolTmpDir(chatId, toolName)`: ephemeral scratch. Create only while a request runs; remove when empty.

Tools receive `chatId` from the registry. Any persisted or indexed user content must be scoped by chat. Avoid ad hoc roots like `~/.arisa/state/<toolName>`, `~/.arisa/state/chats`, or runtime data inside `~/.arisa/tools/<toolName>`.

## Main rule: everything is piped through artifacts
A pipe transforms one input artifact into one output artifact.
Examples:
- voice OGG -> transcript TXT
- text -> MP3 audio
- URL -> downloaded file -> derived file -> transcript

Each tool declares in `tool.manifest.json`:
- `input`: supported input types
- `output`: produced output types
- `configSchema`: required config fields
- `skillHints`: optional skills to apply when using or editing the tool

## Conceptual pipe model
There are two different moments where pipes can happen:

1. **Pre-reasoning normalization pipes**
   - These happen before Pi Agent reasons.
   - Their job is to convert raw inbound media into a form Pi Agent can reason about well.
   - Example: incoming Telegram audio must be transcribed first.
   - In that case, the transcript becomes the effective user message content for Pi Agent.
   - Pi Agent should reason over the transcript, not treat the raw audio as the primary message.

2. **Reasoned action pipes**
   - These happen after Pi Agent starts reasoning.
   - Pi Agent may decide to chain tools to achieve a user goal.
   - Example: text -> TTS audio, or future multi-step workflows.

Not every pipe should be decided by Pi Agent at runtime. Some pipes are part of the transport/input normalization layer and must happen before reasoning.

## Telegram inbound pipeline
- text -> send directly to Pi Agent
- voice -> transcribe first -> send transcript to Pi Agent
- image/document/other media -> keep as artifacts, and add normalization pipes when needed

If inbound media was normalized before reasoning, Pi Agent should use the normalized result as the actual message content.
For example, if a voice note was transcribed, Pi Agent should answer the meaning of the transcript, not simply return the raw transcript unless the user explicitly asked for transcription.

## How to inspect CLI tools
Before using a tool, inspect its help:
- via the custom tool: `tool_help`
- or by running the CLI with `--help`

Every CLI must support (the entrypoint comes from `manifest.entry`, currently always `index.js`):
- `node index.js --help`
- `node index.js run --request-file <json>`

### Tools that need daemons
A future tool may need a persistent process, for example to keep a browser session alive or a local model warm. The shared daemon runtime exists for this, but no bundled tool uses it yet.
When such a tool is built, implement it with the shared daemon runtime instead of custom ad hoc process management:
- use `src/core/tools/daemon-runtime.js`
- keep runtime files under the tool state directory (`~/.arisa/state/tools/<toolName>`)
- expose normal CLI behavior through `run --request-file`; callers should not manage daemon internals
- use the runtime for `daemon.pid`, `daemon.log`, `status.json`, and `commands/*.request|processing|result.json`
- keep one daemon owner per tool/session and avoid opening a second client over the same resource
- use `beforeStart` only for tool-specific cleanup such as stale browser locks, without deleting persistent session/model data
- keep daemon tools headless/server-safe by default when they are meant to run on VPS machines

## Manual pipe behavior
To run a pipe, the agent should:
1. understand whether the needed pipe belongs to pre-reasoning normalization or post-reasoning tool chaining
2. use `list_tools`
3. use `tool_help` when it needs operational details
4. execute a tool with `run_tool`
5. if another step is needed, use the returned `artifactId` as input for the next tool

Example manual pipe:
1. `run_tool(openai-transcribe, artifact audio)`
2. take the returned text `artifactId`
3. `run_tool(openai-tts, artifact text)` or `send_media_reply(text)`

## Async event queue flow
Beyond time-based scheduling, tools can drive an event queue that wakes the agent only when there is something to evaluate. Everything goes through the `asyncTask` (single) or `asyncTasks` (array) field the pipeline already supports; no new Pi tools are needed. The 1s poller drains tasks by `kind`:

- `agent_task`: a scheduled prompt. The poller delivers it as a prompt for Pi to fulfill (time-based work).
- `poll_tool`: a recurring checker the poller **runs directly as a tool** (no agent turn spent). The poller materializes its output with the same logic as `run_tool`, so any `agent_event` the checker emits is enqueued for the next tick. Its `recurrence` reschedules the next poll.
- `agent_event`: an incoming event. The poller delivers it as a prompt so Pi evaluates it and decides the next action (it may stay silent).

Tasks without a `runAt` fire immediately, so `agent_event` and the first `poll_tool` run on the next tick.

The poller dispatches all three kinds, but only `agent_task` is exercised by a bundled tool today (`schedule-agent-task`). The following is the pattern to follow when a checker tool is built:

How a tool wires its own polling:
1. From any tool `run`, start the poll by returning an `asyncTask` (or several in `asyncTasks`):
   `{ kind: "poll_tool", payload: { toolName, args }, recurrence: { type: "interval", everySeconds: N } }`.
2. On each poll the checker tool (`toolName`) runs headless. It keeps its own cursor of seen state in its config/tmp per chat, so it knows what is new.
3. When the checker finds something new, it emits an event from its `run`:
   `{ kind: "agent_event", payload: { prompt: "<content to evaluate>" } }`.
4. The agent reasons over the `agent_event` and decides what to do.

`list_scheduled_tasks`, `cancel_scheduled_task`, and `cancel_all_scheduled_tasks` are kind-agnostic, so they already work to inspect or cancel active polls.

## Missing config flow
If `run_tool` returns `missingConfig`, the agent should:
1. ask the user naturally in Telegram for the missing value
2. write the value with `set_tool_config`
3. retry the tool

Do not assume a rigid question/answer protocol. Continue the conversation naturally and infer the config value from the user reply when possible.

## Tool creation
Reason in terms of capabilities, not tool names.

When the user asks for something new:
1. check whether an existing registered tool can already satisfy the task
2. also check whether the task can be satisfied indirectly through an existing capability
3. only propose creating a new tool when the needed capability is truly missing

Do not stop at "I cannot do that" when the task is realistically implementable through the tool architecture.
The default attitude is:
- identify that no current tool satisfies the request
- state that the missing capability can be added
- propose or start creating the needed tool

When creating or editing tools:
- use the path helpers in `src/runtime/paths.js`
- follow the existing bundled tools under `tools/` as the reference pattern for new tools
- keep all help text, usage instructions, manifests, and user-facing operational strings in English
- follow the One Thing Rule: each function or method should do one thing well; if it mixes low-level operations with high-level policy, split it into smaller focused units

### Tool skill hints
Tools may declare skills in `tool.manifest.json`:

```json
{
  "skillHints": [
    { "name": "stop-slop", "when": "writing public page copy" }
  ]
}
```

The tool registry resolves these from the installed skills directory and injects them into the tool request as `skills`. `list_tools` exposes the hints and `tool_help` shows their resolution status. Skills are guidance for the agent/tool; they are not separate runtime dependencies.

## Dependency installation
Tool dependencies are installed as part of building or running the tool, not delegated to the user.
- Prefer `pnpm install`.
- Fall back to `npm install`.
- Do not ask the user to do it manually.

## Safety
- Do not install or run arbitrary tools outside registered tool manifests in V1.
- Prefer tool manifests and CLI help over assumptions.
- Keep tool config and runtime data inside the user runtime area.
- Be proactive about extending capabilities, but do it through the project's tool architecture, not through ad hoc one-off behavior.
