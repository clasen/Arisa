# Arisa AGENTS

## Core boundaries
Arisa core owns transport, sessions, artifacts, and tool orchestration:
- Telegram transport handles inbound and outbound messaging.
- The active agent runtime keeps one session per authorized chat; Prime is the default for new installs and Pi is temporary rollback support.
- Incoming messages and files (text, voice, photo, document) and generated files become artifacts.
- The tool registry handles tool discovery, help lookup, config writes, and execution.
- Tools are isolated packages with their own manifest, entrypoint, and config defaults.
- No tools ship with the core; installed tools live under `~/.arisa/tools/<toolName>`.
- The Arisa install directory (your working directory) contains only the core. Never create or install tools inside it.
- The pinned Prime runtime is installed and checksum-verified by Arisa under `~/.arisa/runtimes/prime-agent/<version>`; it is separate from mutable Prime state.

New capabilities belong in tools by default. Solve requests by creating or editing a tool under `~/.arisa/tools/<toolName>`. Modifying core is the last resort: do it only after confirming the capability cannot be delivered through the tool architecture, explaining why the core change is unavoidable, and receiving explicit user approval.

## Runtime directory rules
Do not build runtime paths by hand. Use `src/runtime/paths.js`:
- `getToolDir(toolName)`: installed user tool package only; no runtime data here.
- `getToolStateDir(toolName)`: global tool infrastructure only: daemons, queues, shared browser sessions, model caches.
- `getChatToolStateDir(chatId, toolName)`: persistent user/chat data: tool DBs, indexes, inboxes, generated sites, vaults.
- `getChatArtifactsDir(chatId)` / `getChatArtifactsIndexFile(chatId)`: chat artifacts and artifact index. Artifacts are never global.
- `getChatToolConfigPath(chatId, toolName)`: chat-scoped config overrides.
- `getToolTmpDir(toolName)` / `getChatToolTmpDir(chatId, toolName)`: ephemeral scratch. Create only while a request runs; remove when empty.
- `primeRuntimesDir`: root for immutable, versioned Prime Agent installs managed by Arisa. Prime auth, sessions, kernels, and other mutable state do not belong there.

Tools receive `chatId` from the registry. Any persisted or indexed user content must be scoped by chat. Avoid ad hoc roots like `~/.arisa/state/<toolName>`, `~/.arisa/state/chats`, or runtime data inside `~/.arisa/tools/<toolName>`.

## Tool config rules
Every tool has a local `config.js` that exports generic, non-user-specific defaults. Keep user credentials, deployment-specific URLs, account ids, phone numbers, and other per-user values empty or neutral there; document required values in `tool.manifest.json` `configSchema`.

Tools must consume config through `src/core/tools/tool-config.js`:
- `loadToolConfig(toolName, defaults)` for global tools and daemons that run as one shared process.
- `loadToolConfig(toolName, defaults, request.chatId)` inside `run()` for request-scoped tools that should honor per-chat overrides.

Config precedence is a shallow merge: tool defaults -> global tool config (`~/.arisa/tools/<toolName>/config.js`) -> chat tool config (`~/.arisa/chats/<chatId>/config/tools/<toolName>/config.js`). Per-request `args` may override loaded config for that invocation only; do not persist request args as config unless the user explicitly asked to set a default.

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
- `category`: optional broad capability bucket for discovery
- `keywords`: optional intent tags for capability discovery
- `skillHints`: optional skills to apply when using or editing the tool

## Text encoding
All textual content generated or sent by Arisa or its tools must use UTF-8. This includes text files, assistant-created attachments, tool exports, email bodies, messages, HTTP responses, and API payloads.

- Text files must start with a UTF-8 byte-order mark (BOM).
- Protocol payloads must declare UTF-8 through the protocol's standard mechanism and encode their bytes as UTF-8. For example, email and HTTP text content must use a `Content-Type` with `charset=UTF-8`.

## Tool-to-Arisa IPC
Tools that expose a web UI or HTTP endpoint own that server, usually through the shared daemon runtime; Arisa core does not mount tool routes or proxies. Use Arisa IPC when a tool needs registered tools, artifacts, tasks, agent events, or runtime paths.

Import the IPC client through `ARISA_PACKAGE_DIR`:

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { createArisaClient } = await importCore("core/tools/ipc-client.js");

const arisa = createArisaClient({ toolName: "example-tool", chatId });
await arisa.artifacts.createText({ text: "hello" });
const result = await arisa.tools.run({
  name: "strudel-agent",
  text: prompt,
  args: { bpm, tags, currentCode }
}, { timeoutMs: 120_000 });
```

The IPC channel is a local socket under `~/.arisa/state`. Every request must include `toolName`; chat-scoped capabilities also require `chatId`. Prime bridge requests additionally carry a random capability token bound to that chat. Exposed capabilities are explicit: tools (`list`, `help`, `skills`, `setConfig`, `run`), artifacts (`createText`, `listRecent`, `get`, `deliver`), tasks (`add`, `list`, `cancel`, `cancelAll`), agent events (`enqueueEvent`), and runtime paths (`getChatToolStateDir`, `getToolStateDir`, `getChatToolTmpDir`, `getToolTmpDir`, `getChatArtifactsDir`). Do not expose raw `agentManager`, `taskStore`, `artifactStore`, or `toolRegistry` access.

## Conceptual pipe model
There are two different moments where pipes can happen:

1. **Pre-reasoning normalization pipes**
   - These happen before the active agent runtime reasons.
   - Their job is to convert raw inbound media into a form the agent can reason about well.
   - Example: incoming Telegram audio must be transcribed first.
   - In that case, the transcript becomes the effective user message content for the agent.
   - The agent should reason over the transcript, not treat the raw audio as the primary message.

2. **Reasoned action pipes**
   - These happen after the agent starts reasoning.
   - The agent may decide to chain tools to achieve a user goal.
   - Example: text -> TTS audio, or future multi-step workflows.

Not every pipe should be decided by the agent at runtime. Some pipes are part of the transport/input normalization layer and must happen before reasoning.

## Telegram inbound pipeline
- text -> send directly to the active agent runtime
- voice -> transcribe first -> send transcript to the active agent runtime
- image/document/other media -> keep as artifacts, and add normalization pipes when needed

If inbound media was normalized before reasoning, the agent should use the normalized result as the actual message content.
For example, if a voice note was transcribed, the agent should answer the meaning of the transcript, not simply return the raw transcript unless the user explicitly asked for transcription.

## Telegram outbound replies
- Short textual replies are sent inline as a normal Telegram message.
- When a textual reply is too large to read comfortably inline, it is delivered as a generated Markdown artifact instead of a long inline message. The transport handles this automatically in `sendTextReply`: replies over the inline length limit become a `reply-<timestamp>.md` artifact sent as a document.
- This is a transport-layer concern. The agent should write the full answer it wants to deliver and not pre-split or truncate it to fit the chat; the transport decides between inline text and a Markdown attachment.

## How to inspect CLI tools
Before using a tool, inspect its help:
- via the custom tool: `tool_help`
- or by running the CLI with `--help`

Every CLI must support (the entrypoint comes from `manifest.entry`, currently always `index.js`):
- `node index.js --help`
- `node index.js run --request-file <json>`

### Tools that need daemons
A tool may need a persistent process, for example to keep a browser session alive or a local model warm. The shared daemon runtime exists for this (the `whispermix-transcribe` catalog tool uses it).
When such a tool is built, implement it with the shared daemon runtime instead of custom ad hoc process management:
- use `src/core/tools/daemon-runtime.js`
- keep runtime files under the tool state directory (`~/.arisa/state/tools/<toolName>`)
- expose normal CLI behavior through `run --request-file`; callers should not manage daemon internals
- use the runtime for `daemon.pid`, `daemon.log`, `status.json`, and `commands/*.request|processing|result.json`
- keep one daemon owner per tool/session and avoid opening a second client over the same resource
- use `beforeStart` only for tool-specific cleanup such as stale browser locks, without deleting persistent session/model data
- keep daemon tools headless/server-safe by default when they are meant to run on VPS machines
- if the daemon exposes an HTTP server, keep that server inside the tool; Arisa core does not discover or mount tool routes

Every managed daemon must also follow the scoped health contract:
- declare `daemon.scope`, `daemon.autoStart`, and `daemon.health: "internal"` in `tool.manifest.json`
- use `{ type: "global" }` for shared infrastructure, or `{ type: "chat", chatId }` for one isolated process per chat
- implement `workLoop({ processJob, healthCheck, recover })`; `healthCheck` must exercise the real capability without human input, and `recover` is optional
- never write `ready` directly: the shared runtime sets it only after the health operation succeeds through the normal command queue
- keep daemon infrastructure for a chat-scoped process under `getChatToolStateDir(chatId, toolName)/daemon`; keep user data such as sessions, inboxes, and databases outside that subdirectory
- persist only non-secret launch identity in `startupContext`; reload global or chat-scoped tool config after every process restart
- use only the standard daemon states: `starting`, `ready`, `degraded`, `unhealthy`, `restarting`, `stopped`, `failed`

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
3. `run_tool(openai-tts, artifact text)` to generate audio, then `send_artifact(artifactId)` to deliver it (or `run_tool(openai-tts, artifact text, deliver: true)` to generate and send in one step)

Delivery is generic: any `run_tool` output that produces a file becomes an artifact, and `send_artifact(artifactId)` delivers it to the chat. The delivery method and filename are derived from the artifact (its `delivery` hint, `kind`, and stored name); internal local paths are never exposed. No caption is sent by default: the filename already appears on the attachment, so it is never duplicated into the caption text (which would let Telegram autolink a filename like `example.md` as a URL). A caption is shown only when an explicit one is passed. Tools declare their delivery intent by returning `delivery: { method }` in their output; they do not deliver to the transport themselves. As a shortcut, `run_tool` accepts `deliver: true` to generate and deliver in a single step; use it only when the user should receive the file now, not for intermediate pipe steps.

## Async event queue flow
Beyond time-based scheduling, tools can drive an event queue that wakes the agent only when there is something to evaluate. Everything goes through the `asyncTask` (single) or `asyncTasks` (array) field the pipeline already supports; no new native agent tools are needed. The 1s poller drains tasks by `kind`:

- `agent_task`: a scheduled prompt. The poller delivers it as a prompt for the active runtime to fulfill (time-based work).
- `poll_tool`: a recurring checker the poller **runs directly as a tool** (no agent turn spent). The poller materializes its output with the same logic as `run_tool`, so any `agent_event` the checker emits is enqueued for the next tick. Its `recurrence` reschedules the next poll.
- `agent_event`: an incoming event. The poller delivers it as a prompt so the active runtime evaluates it and decides the next action (it may stay silent).

Tasks without a `runAt` fire immediately, so `agent_event` and the first `poll_tool` run on the next tick.

The poller dispatches all three kinds, but only `agent_task` is exercised by a catalog tool today (`schedule-agent-task`). The following is the pattern to follow when a checker tool is built:

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

## Capability resolution
Reason in terms of capabilities, not tool names. Do not stop at "I cannot do that" when the task is realistically implementable through the tool architecture.

Before asking the user for recurrent context, inspect available tools by `category` and `keywords`, especially `memory`, `context`, `contacts`, and `essential`.

When the user asks for something new:
1. check whether an existing registered tool, or an indirect use of one, can satisfy the task
2. check the official catalog at `https://github.com/clasen/Arisa/tree/main/tools` before building anything
3. install from the catalog when it fits, or create a new tool only when the needed capability is truly missing

To evaluate the official catalog:
1. List it: `curl -s https://api.github.com/repos/clasen/Arisa/contents/tools`.
2. Read each candidate manifest at `https://raw.githubusercontent.com/clasen/Arisa/main/tools/<name>/tool.manifest.json`; `description`, `input`, and `output` show whether it solves the need.
3. Read the catalog `README.md` and use its `Install footprint` column:
   - **Low footprint**: install it and resolve the request in the same turn, without asking first.
   - **Medium/High footprint**: tell the user which tool it is, what it does, and wait for confirmation before installing.
   - Missing config secrets are handled by the missing-config flow and are not, on their own, a reason to ask before installing.

When installing any approved or low-footprint tool:
1. Download it into `~/.arisa/tools/<name>`. For the official catalog, clone shallowly and copy the subdirectory, for example:
   `git clone --depth 1 https://github.com/clasen/Arisa /tmp/arisa-catalog && cp -R /tmp/arisa-catalog/tools/<name> ~/.arisa/tools/<name>`.
2. Install dependencies inside the tool directory with `pnpm install`, falling back to `npm install`. Do not ask the user to install dependencies manually.
3. Run it through `run_tool`; the registry picks up new tools automatically and exposes the Arisa package root through `ARISA_PACKAGE_DIR`. If it returns `missingConfig`, follow the missing config flow.

When creating or editing tools:
- follow the core boundary above: create or edit installed tools under `~/.arisa/tools/<toolName>`, never inside the Arisa install directory
- use the path helpers in `src/runtime/paths.js` for state, config, artifacts, and tmp paths
- import Arisa core helpers dynamically through `ARISA_PACKAGE_DIR` (for example `await importCore("core/tools/tool-result.js")`); never use `../../src/...` or rewritten absolute paths
- follow the tools in the official catalog as the reference pattern for new tools
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

If a tool executes deterministic logic over skill content, bundle the required skill assets inside the tool package and treat injected `skills` only as an optional override. A catalog tool must still work when the hinted skill is not installed on the target Arisa instance.

## Safety
- Prefer tool manifests and CLI help over assumptions.
- Keep config and runtime data inside the user runtime area through the path helpers above.
- Be proactive about extending capabilities through the tool architecture, not ad hoc one-off behavior.
