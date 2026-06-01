# Arisa AGENTS

## Architecture
- Telegram transport handles inbound and outbound messaging.
- Pi Agent keeps one session per authorized chat.
- Every incoming or generated message or file becomes an artifact.
- A tool registry handles tool discovery, help lookup, config writes, and execution.
- Tools are isolated and each one has its own manifest, entrypoint, and config defaults.

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

This distinction is critical. Not every pipe should be decided by Pi Agent at runtime. Some pipes are part of the transport/input normalization layer and must happen before reasoning.

## Telegram inbound pipeline
Current conceptual behavior:
- text -> send directly to Pi Agent
- audio/voice -> transcribe first -> send transcript to Pi Agent
- image/document/other media -> keep as artifacts, and add normalization pipes when needed

If inbound media was normalized before reasoning, Pi Agent should use the normalized result as the actual message content.
For example, if a voice note was transcribed, Pi Agent should answer the meaning of the transcript, not simply return the raw transcript unless the user explicitly asked for transcription.

## How to inspect CLI tools
Before using a tool, inspect its help:
- via the custom tool: `tool_help`
- or by running the CLI with `--help`

Every CLI must support:
- `node index.js --help`
- `node index.js run --request-file <json>`

### Tools that need daemons
Some tools need a persistent process, for example to keep a browser session alive or a local model warm.
Implement these tools with the shared daemon runtime instead of custom ad hoc process management:
- use `src/core/tools/daemon-runtime.js`
- keep runtime files under the tool state directory (`stateDir/<toolName>`)
- expose normal CLI behavior through `run --request-file`; callers should not manage daemon internals
- use the runtime for `daemon.pid`, `daemon.log`, `status.json`, and `commands/*.request|processing|result.json`
- keep one daemon owner per tool/session and avoid opening a second client over the same resource
- use `beforeStart` only for tool-specific cleanup such as stale browser locks, without deleting persistent session/model data
- keep daemon tools headless/server-safe by default when they are meant to run on VPS machines

## Pipe behavior in V1
V1 does not have a full automatic planner yet. The agent should:
1. understand whether the needed pipe belongs to pre-reasoning normalization or post-reasoning tool chaining
2. use `list_tools`
3. use `tool_help` when it needs operational details
4. execute a tool with `run_tool`
5. if another step is needed, use the returned `artifactId` as input for the next tool

Example manual pipe:
1. `run_tool(openai-transcribe, artifact audio)`
2. take the returned text `artifactId`
3. `run_tool(openai-tts, artifact text)` or `send_audio_reply(text)`

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
- use the shared path helpers and the runtime paths provided in the prompt instead of assuming fixed locations
- consult the local skill for that workflow when building new tools
- keep all help text, usage instructions, manifests, and user-facing operational strings in English
- follow the One Thing Rule: each function or method should do one thing well; if it mixes low-level operations with high-level policy, split it into smaller focused units

## Dependency installation
Arisa installs tool dependencies itself.
- Prefer `pnpm install`.
- Fall back to `npm install`.
- Do not ask the user to do it manually.

## Safety
- Do not install or run arbitrary tools outside registered tool manifests in V1.
- Prefer tool manifests and CLI help over assumptions.
- Keep tool config and runtime data inside the user runtime area.
- Be proactive about extending capabilities, but do it through the project's tool architecture, not through ad hoc one-off behavior.
