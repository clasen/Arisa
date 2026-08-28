# Arisa

[Arisa](https://arisa.sh) is a personal assistant you talk to through Telegram, powered by Pi Agent and isolated CLI tools.

## Origin

The initial inspiration was OpenClaw, which has interesting ideas but carries a lot of weight compared with Arisa's focused core: when it generates tools they end up disorganized, and the overall framework feels overloaded.

The real heart of OpenClaw is Pi Agent: a [minimal terminal coding harness](https://www.youtube.com/watch?v=Dli5slNaJu0) that lets an AI agent reason and act with very little infrastructure. That part is genuinely good.

Telegram bots, on the other hand, work extremely well as a human interface. Simple, reliable, always in your pocket.

Arisa keeps Telegram as its interface and Pi Agent as its single reasoning harness.

It is designed around a simple idea:

- **Telegram is the human interface**
- **Pi Agent is the reasoning engine**
- **everything is an artifact**
- **capabilities live in isolated CLI tools**
- **tools can be chained through pipes**

If a capability does not exist yet, the system adds a new tool for it. The agent grows from real use, not from assumptions.

## Core concept

Arisa separates two different kinds of pipes:

1. **Pre-reasoning normalization pipes**
   - These happen before Pi Agent reasons.
   - Example: a Telegram voice message is transcribed first.
   - Pi Agent then reasons over the transcript, not over the raw audio.

2. **Reasoned action pipes**
   - These happen after Pi Agent starts reasoning.
   - Example: text -> TTS audio.
   - Future tools can form larger chains.

This distinction is important. Some transformations belong to the transport/input layer, not to the agent's runtime decision making.

## Zero tools, assembled on demand

A fresh install ships with **zero Arisa modular tools**. The core is Telegram transport, the Pi Agent reasoning loop, the artifact store, and the tool registry. Out of the box Arisa cannot transcribe audio, browse the web, or speak; it gains each capability only once a tool that provides it is installed.

Arisa assembles its own toolset from real use:

1. A request arrives that the current tools cannot satisfy.
2. Arisa checks the [official catalog](https://github.com/clasen/Arisa/tree/main/tools) for a tool that fits the need.
3. If one fits, it installs it: autonomously for low-footprint tools, or after asking you to confirm for heavier ones (extra dependencies, external binaries, or interactive setup such as a login).
4. If nothing fits, it builds a new tool for the missing capability.
5. The installed tool stays in `~/.arisa/tools/` and is reused from then on.

The result is a toolset shaped by how you actually use the assistant, not by defaults someone else chose. Two people running the same Arisa build can end up with completely different capabilities.

## Current behavior

### Telegram input
- text messages go directly to Pi Agent
- audio/voice messages are transcribed first when a transcription tool is installed, then passed to Pi Agent as text; otherwise the agent is told transcription failed and can offer to install one
- media is stored as artifacts
- while a chat is busy, concurrent text steers Pi's active run by default
- set `telegram.busyMessageMode` to `"queue"` to keep concurrent text messages in order; override one chat with `telegram.chatMeta[chatId].busyMessageMode`
- media and normalized audio stay queued, and failed steering falls back to the ordered queue
- an owner-workspace General topic may route only the assistant's visible reply to a matching topic; the incoming message and General session remain unchanged, and ambiguous replies stay in General
- reply classification never runs in private chats or outside General
- each owner workspace keeps a dynamic, chat-scoped topic registry; Arisa learns topic creation, rename, close, and reopen events, and records the context of topics it creates or initializes
- when a substantial theme recurs in General without a matching topic, Arisa may occasionally propose a new one; creation still requires explicit user confirmation
- legacy `replyTopics` configuration is imported once into the dynamic registry and then removed

### Tool model
No tools ship with the core. All installed tools live under `~/.arisa/tools/<tool-name>`, whether they come from the [official catalog](https://github.com/clasen/Arisa/tree/main/tools), from another source the user chooses, or are created by the agent itself.

When the agent needs a capability it does not have, it checks the official catalog first. Low-footprint tools (no extra dependencies) are installed on the spot so the request is resolved in the same turn; heavier tools (extra dependencies, external binaries, or interactive setup) are proposed for you to confirm before anything is installed.

Each tool folder contains:

- `package.json`
- `config.js`
- `tool.manifest.json`
- `index.js`

`tool.manifest.json` may also include optional `skillHints`; Arisa resolves installed skills and passes them into `run_tool` requests as `skills` guidance, not runtime dependencies.

A tool that requires another Arisa tool declares a versioned `toolDependencies` map, for example `{ "mcp-client": "^0.1.0" }`. Official installation resolves these dependencies first, rejects missing or cyclic lock entries, and validates installed versions. The registry blocks execution when a required tool is missing or incompatible, and `/doctor` reports the issue.

Each tool is isolated from the root project and from other tools.
That isolation is part of the architecture:

- each tool has its own folder
- each tool has a local `config.js` for defaults/template values
- each tool can have its own dependencies
- one tool can be changed or replaced without tightly coupling the rest of the system

### Configuration model
All runtime state lives under `~/.arisa/`, split between global state and per-chat state.

Global:
- runtime config is stored in `~/.arisa/state/config.json`
- the scheduled-task queue is stored in `~/.arisa/state/tasks.json`
- installed tools live under `~/.arisa/tools/<tool>/`, each with a default `config.js` template
- global tool runtime state (daemons, caches, temp) lives under `~/.arisa/state/tools/<tool>/`

Per chat (`~/.arisa/chats/<chatId>/`):
- artifact files are stored under `artifacts/`
- the artifact index is stored in `state/artifacts.json`
- Pi sessions live under `state/pi-sessions/<revision>/`
- chat-scoped tool config overrides live in `config/tools/<tool>/config.js`
- chat-scoped daemon infrastructure lives in `state/tools/<tool>/daemon/`; persistent tool data stays beside it
- ephemeral scratch lives under `tmp/`

Managed daemons become ready only after their tool-defined health operation succeeds through the normal command queue. Arisa records heartbeats, successful jobs, errors, and standard lifecycle states, then retries recovery or recreates an unhealthy process with its persisted scope and startup context. The supervisor automatically removes registrations and daemon runtime directories that no longer match an installed daemon tool. A live process is terminated only when its command line matches the registered entry and daemon invocation; unverifiable PIDs are left untouched and reported for attention.

Daemon tools may opt into the `arisa-daemon-v1` local protocol for immediate
multiplexed jobs and incremental NDJSON events over a capability-protected local
socket. The runtime persists request, accepted and terminal records so a restart
can recover queued work and will not silently repeat an accepted effect. When a
client deadline expires, the runtime sends a scoped cancellation signal to that
job before closing the request; cooperative tools can stop it without restarting
the shared daemon or interrupting unrelated sessions. Legacy daemon tools
continue to use the existing request-file contract.

### Arisa Master and Slave

The official `master-slave` daemon tool lets one normal Arisa installation act
as Master for deterministic headless Slave hosts. Master keeps Telegram and Pi;
Slave runs only the IPC host, daemon supervisor and installed tools. Connections
are authenticated, encrypted, initiated by Slave and restricted by per-Slave
roots and capability grants.

Linux with systemd is the first supported Slave target. Bootstrap uses a
single-use URL issued by Master:

```bash
npm i -g arisa && arisa slave tcp://198.51.100.12:4719/arisa_secret_v1_<secret>
```

The URL is sensitive and may remain in shell history. `arisa slave status`,
`log`, `tools`, `start`, `stop`, `restart` and `unpair` operate the isolated
headless service without starting Telegram or Pi Agent.

Pi authentication can use either:
- an API key entered during bootstrap
- or Pi's existing OAuth login when supported, such as `openai-codex`

Automatic context compaction uses Pi's native implementation and can be tuned in `~/.arisa/state/config.json`:

```json
{
  "pi": {
    "compaction": {
      "enabled": true,
      "reserveTokens": 120000,
      "keepRecentTokens": 20000
    },
    "sessionRotation": {
      "enabled": true,
      "compactAtPersistedBytes": 25165824,
      "maxPersistedBytes": 33554432
    }
  }
}
```

Pi compacts when the context exceeds the model's context window minus `reserveTokens`. Arisa also requests compaction when persisted history exceeds `compactAtPersistedBytes`, then rotates to a fresh JSONL using the latest summary and retained active context. Before Pi loads a recent session above `maxPersistedBytes`, Arisa discovers the last valid active-branch compaction by streaming, atomically creates a compact child with `parentSession`, and leaves the historical JSONL intact. An unsafe oversized session is rejected rather than loaded into an OOM-prone worker. Set a smaller token reserve when using models with substantially smaller context windows. Arisa adds no Telegram commands or compaction notifications.

## Install globally

```bash
npm install -g arisa
```

Then run:

```bash
arisa
```

Command modes:

```bash
arisa                    # foreground, blocking
arisa start              # start in background
arisa stop               # stop background service
arisa restart            # restart background service, or start it if stopped
arisa status             # show background service status
arisa flush              # remove ~/.arisa
arisa --silent           # run without verbose logs
```

Authorized Telegram chats can run the same safe service lifecycle with `/restart`.

Background mode runs the Telegram/Pi worker under a lightweight supervisor. Unexpected worker exits use bounded exponential restart backoff. After recovery, authorized Telegram chats automatically receive a bounded report with the classified exit cause, recent tool names and counts, uncertain scheduled executions, restart delay, and running version; prompts and private payloads are never included. Scheduled agent tasks are serialized FIFO per conversation while different conversations remain independent; execution deadlines default to 15 minutes for scheduled prompts and 5 minutes for agent events. A timed-out turn is marked outcome-uncertain and is never replayed automatically. These policies can be overridden with `service.workerRestart*` and `tasks.*TimeoutMs` in the Arisa config.

Tools may opt into weighted resource governance with a manifest declaration such as `"execution": { "resourceClass": "browser", "weight": 1 }`; undeclared lightweight and nested orchestration calls remain unconstrained. Declared runs queue when their class reaches its concurrency capacity. A global memory broker also reserves RAM across declared classes, leaving configurable system and core reserves before it admits work. The broker starts declared tools with a 384 MiB recommendation, derives their V8 heap from the granted memory, and raises the recommendation after an isolated memory-limit failure. Manifest values for `maxHeapMb` and `maxMemoryMb` act as ceilings; `maxOutputBytes` bounds protocol output. On systemd-based Linux hosts, each declared process tree runs in `arisa-tools.slice` with `MemoryHigh`, `MemoryMax`, bounded swap, and a higher OOM-kill priority than the core. Tool daemons receive the same OOM priority. Arisa lowers the core OOM score when the service account permits it. A limit failure stays inside the tool process tree and returns an uncertain result. Set host reserves and dynamic grants with `toolExecution.systemReserveMb`, `coreReserveMb`, `initialToolMemoryMb`, `minimumToolMemoryMb`, and `maximumToolMemoryMb`. Heap, soft-pressure, and swap controls use `toolHeapPercent`, `toolMemoryHighPercent`, and `toolSwapMaxMb`. Admission still checks `maxWorkerRssMb` and `maxSwapUsedPercent`. Class controls remain available through `defaultCapacity`, `capacities`, and `maxQueuedPerClass`. `deduplicateConcurrent: true` joins exact concurrent duplicates from the same chat.

Runtime model override (current process only):

```bash
arisa --pi.model openai-codex/gpt-5.6
```

Notes:

- it only affects the current Arisa process and does not update `~/.arisa/state/config.json`

## Multiple instances

Set `ARISA_HOME` to run separate Arisa instances on the same machine:

```bash
ARISA_HOME=~/.arisa-work arisa
ARISA_HOME=~/.arisa-personal arisa start
```

Each home has its own Telegram config, Pi login, installed tools, daemons, chat sessions, artifacts, IPC socket, PID file, and logs. Pi OAuth credentials are stored in `<home>/state/pi-auth.json`, so existing installs authenticate once again after upgrading.

## Bootstrap flow

On first run, Arisa walks you through three steps:

1. Give it a Telegram bot token (create one with [@BotFather](https://t.me/BotFather)) and Arisa validates it.
2. Continue setup in Telegram (the default): open the link to authorize your chat, then pick the Pi provider, model, and auth, and whether to keep running in the background.
3. Once Pi is working, Arisa starts listening.

## ChatGPT subscription is enough to run Arisa

Allows Arisa to authenticate through Pi's Codex OAuth flow instead of requiring a normal OpenAI API key. This means a regular ChatGPT subscription is enough to run Arisa on GPT-5.5, which is powerful and a genuine pleasure to use.

## Project structure

```txt
src/
  runtime/      bootstrap + app startup
  transport/    Telegram integration
  core/         agent, tools, artifacts, config
~/.arisa/
  state/              global config, task queue, IPC socket
    config.json
    pi-auth.json
    tasks.json
    tools/<tool>/     global tool state (daemons, caches, tmp)
  tools/<tool>/       installed tools (catalog, user-chosen, or agent-created)
  chats/<chatId>/
    artifacts/        per-chat artifact files
    state/            artifact index + Pi session
    config/tools/     chat-scoped tool config overrides
    tmp/              ephemeral scratch
```

The official tool catalog lives in the repository under [`tools/`](https://github.com/clasen/Arisa/tree/main/tools) and is not part of the npm package.

## Philosophy

The agent should not come preloaded with vices or assumptions. It starts minimal and grows through real use: shaped by the user, not by the framework.

For consistency, the entire Arisa codebase was built using Pi Agent itself, running on Codex: the model bundled with ChatGPT Plus. The goal was to see how far a model that most people already have access to could go when given a good harness. The experience was genuinely satisfying: having the agent reason about, extend, and improve its own system is exactly the kind of recursive loop the project is designed for.

When a capability is missing:

1. check whether an installed tool can solve the task
2. if not, check the official catalog and propose installing the matching tool
3. if nothing fits, build the missing tool
4. keep the solution inside the tool architecture

No "I can't do that" when the thing is realistically buildable.

## Notes

- `AGENTS.md` defines the project-level behavioral rules for the active agent runtime
- `src/transport/telegram/bot.js` builds the per-message runtime prompt
- tool help is part of the architecture and should be consulted before use when details are unclear

## Status

This is currently a functional V1. The core provides:

- Telegram transport
- Pi Agent session and model integration
- artifact-based message handling
- the isolated CLI tool registry (starts empty)
- pre-reasoning and post-reasoning pipes
- queued follow-up message batching

Concrete capabilities such as audio transcription or text-to-speech are not built in; they are added as tools from the catalog (or built on demand) when a request needs them.

Future capabilities should be added as new tools and pipes, not as tightly coupled one-off code paths.
