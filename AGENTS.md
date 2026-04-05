# Arisa AGENTS

## Architecture
- `src/transport/telegram/*`: Telegram inbound and outbound transport.
- `src/core/agent/*`: Pi Agent sessions, one per authorized chat.
- `src/core/artifacts/*`: every incoming or generated message/file becomes an artifact.
- `src/core/tools/*`: CLI tool registry, help lookup, config writes, execution.
- `cli/*`: isolated tools. Each tool has `package.json`, `config.js`, `tool.manifest.json`, and `index.js`.

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
2. write the value into `cli/<tool>/config.js` with `set_tool_config`
3. retry the tool

Do not assume a rigid question/answer protocol. Continue the conversation naturally and infer the config value from the user reply when possible.

## Telegram security
- The first chat that messages the bot is authorized if `telegram.maxChatIds` allows it.
- Do not authorize more chats than configured.
- Access control is based on chat ids, not usernames.

## Tool creation
Do not assume specific future tools such as YouTube support exist.
If the user asks for a capability that is not currently available, first check whether an existing registered tool can satisfy the task.
If no existing tool can do it, the default attitude should be to propose creating a new CLI tool under `cli/<tool-name>` following the project conventions.
All newly created tools must document their help text, usage instructions, manifests, and user-facing operational strings in English.
Do not stop at "I cannot do that" when the task is realistically implementable through a new tool.
Prefer responses like:
- identify that no current tool satisfies the request
- state that the missing capability can be added
- propose or start creating the tool needed to fulfill the request

For example, if the user asks for live weather and no weather tool exists, the correct attitude is to propose building a weather tool for the bot rather than only saying real-time access is unavailable.

When creating or editing tools, follow the shared path helpers in `src/runtime/paths.js` and `src/core/tools/tool-config.js`:
- config in `~/.arisa/tools/<tool>/config.js`
- temp/runtime files in `~/.arisa/tmp/tools/<tool>/`
- durable generated files should become artifacts in `~/.arisa/artifacts/`

Consult the local skill for that workflow when building new tools.

## Safety
- Do not install or run arbitrary tools outside registered `cli/*` manifests in V1.
- Prefer tool manifests and CLI help over assumptions.
- Keep tool configs inside `~/.arisa/tools/<tool>/config.js`.
- Be proactive about extending capabilities, but do it through the project's tool architecture, not through ad hoc one-off behavior.
