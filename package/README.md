# Arisa

[Arisa](https://arisa.sh) is a personal assistant you talk to through Telegram, powered by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

## Origin

The initial inspiration was OpenClaw, which has interesting ideas but carries a lot of weight compared with Arisa's focused core: when it generates tools they end up disorganized, and the overall framework feels overloaded.

The real heart of OpenClaw is Pi Agent: a [minimal terminal coding harness](https://www.youtube.com/watch?v=Dli5slNaJu0) that lets an AI agent reason and act with very little infrastructure. That part is genuinely good.

Telegram bots, on the other hand, work extremely well as a human interface. Simple, reliable, always in your pocket.

Arisa now keeps Telegram as its interface and uses Prime Agent as its reasoning engine, while retaining Pi temporarily as a rollback runtime for existing installations.

It is designed around a simple idea:

- **Telegram is the human interface**
- **Prime Agent is the reasoning engine**
- **everything is an artifact**
- **capabilities live in isolated CLI tools**
- **tools can be chained through pipes**

If a capability does not exist yet, the system adds a new tool for it. The agent grows from real use, not from assumptions.

## Why Prime Agent changes the equation

Prime Agent is more than a model backend. Its [RLM and Continual Harness architecture](https://www.primeintellect.ai/blog/prime-agent) puts context, delegation, and adaptation inside the reasoning loop:

- **Programmatic context:** persistent IPython keeps history, tools, and working data addressable as variables.
- **Recursive workers:** sub-agents are asynchronous function calls with their own session, history, and kernel. They can run in parallel, stay in the background, and be resumed later.
- **Evidence-backed improvement:** `/refine` turns actual outcomes into small, durable updates to prompts, memories, skills, or sub-agent specifications.

That is Arisa's architectural differential from [OpenClaw](https://github.com/openclaw/openclaw): OpenClaw offers a broad Gateway for channels, devices, apps, and plugins; Arisa keeps a focused Telegram, artifact, and CLI-tool shell while Prime supplies recursive, long-horizon reasoning.

On EmulatorBench, it built SEGA Genesis and Game Boy Color emulators from scratch in Rust, reproducing target hardware behavior against diagnostic tests.

Prime Intellect also reports **95.5% Best@1 on ARC-AGI-3 with Opus 5**, just above the reported 95.4% human-expert baseline. These are Prime Agent results, not Arisa benchmarks.

![Prime Agent ARC-AGI-3 test-time compute scaling](./package/docs/images/prime-agent-arc-agi-3.jpeg)

## Core concept

Arisa separates two different kinds of pipes:

1. **Pre-reasoning normalization pipes**
   - These happen before Prime Agent reasons.
   - Example: a Telegram voice message is transcribed first.
   - Prime Agent then reasons over the transcript, not over the raw audio.

2. **Reasoned action pipes**
   - These happen after Prime Agent starts reasoning.
   - Example: text -> TTS audio.
   - Future tools can form larger chains.

This distinction is important. Some transformations belong to the transport/input layer, not to the agent's runtime decision making.

## Zero tools, assembled on demand

A fresh install ships with **zero Arisa modular tools**. The core is Telegram transport, the Prime Agent reasoning loop with its native IPython tool, the artifact store, and the tool registry. Out of the box Arisa cannot transcribe audio, browse the web, or speak; it gains each capability only once a tool that provides it is installed.

Arisa assembles its own toolset from real use:

1. A request arrives that the current tools cannot satisfy.
2. Arisa checks the [official catalog](https://github.com/clasen/Arisa/tree/main/tools) for a tool that fits the need.
3. If one fits, it installs it: autonomously for low-footprint tools, or after asking you to confirm for heavier ones (extra dependencies, external binaries, or interactive setup such as a login).
4. If nothing fits, it builds a new tool for the missing capability.
5. The installed tool stays in `~/.arisa/tools/` and is reused from then on.

The result is a toolset shaped by how you actually use the assistant, not by defaults someone else chose. Two people running the same Arisa build can end up with completely different capabilities.

## Current behavior

### Telegram input
- text messages go directly to Prime Agent
- audio/voice messages are transcribed first when a transcription tool is installed, then passed to Prime Agent as text; otherwise the agent is told transcription failed and can offer to install one
- media is stored as artifacts

### Tool model
No tools ship with the core. All installed tools live under `~/.arisa/tools/<tool-name>`, whether they come from the [official catalog](https://github.com/clasen/Arisa/tree/main/tools), from another source the user chooses, or are created by the agent itself.

When the agent needs a capability it does not have, it checks the official catalog first. Low-footprint tools (no extra dependencies) are installed on the spot so the request is resolved in the same turn; heavier tools (extra dependencies, external binaries, or interactive setup) are proposed for you to confirm before anything is installed.

Each tool folder contains:

- `package.json`
- `config.js`
- `tool.manifest.json`
- `index.js`

`tool.manifest.json` may also include optional `skillHints`; Arisa resolves installed skills and passes them into `run_tool` requests as `skills` guidance, not runtime dependencies.

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
- Prime auth is stored in `~/.arisa/state/prime-agent/auth.json`; compatible Pi OAuth credentials are copied there with `0600` permissions
- managed Prime releases live under `~/.arisa/runtimes/prime-agent/<version>/`
- the scheduled-task queue is stored in `~/.arisa/state/tasks.json`
- installed tools live under `~/.arisa/tools/<tool>/`, each with a default `config.js` template
- global tool runtime state (daemons, caches, temp) lives under `~/.arisa/state/tools/<tool>/`

Per chat (`~/.arisa/chats/<chatId>/`):
- artifact files are stored under `artifacts/`
- the artifact index is stored in `state/artifacts.json`
- Prime sessions live under `state/prime-sessions/<revision>/`; legacy Pi sessions remain under `state/pi-sessions/`
- chat-scoped tool config overrides live in `config/tools/<tool>/config.js`
- chat-scoped daemon infrastructure lives in `state/tools/<tool>/daemon/`; persistent tool data stays beside it
- ephemeral scratch lives under `tmp/`

Managed daemons become ready only after their tool-defined health operation succeeds through the normal command queue. Arisa records heartbeats, successful jobs, errors, and standard lifecycle states, then retries recovery or recreates an unhealthy process with its persisted scope and startup context.

Pi authentication can use either:
- an API key entered during bootstrap
- or Pi's existing OAuth login when supported, such as `openai-codex`

## Install globally

```bash
npm install -g arisa
```

Then run:

```bash
arisa
```

On first start, Arisa downloads the pinned Prime Agent release, verifies its
official SHA-256 checksum, and installs it privately under
`~/.arisa/runtimes/prime-agent/<version>/`. It never installs Prime globally and
does not depend on a `prime-agent` command already being present on `PATH`.

Arisa intentionally rejects other Prime versions until their RPC contract passes
the Arisa test suite. Prime runs IPython kernels and recursive workers with the
permissions of your user account; it is not a sandbox.

To use an externally managed Prime installation instead, configure an explicit
command:

```bash
arisa --agent.runtime prime --prime.command /absolute/path/to/prime-agent
```

`PRIME_AGENT_DOWNLOAD_BASE_URL` may point managed installs at a trusted HTTPS
mirror with the same versioned tarball and `SHA256SUMS` layout.

Command modes:

```bash
arisa                    # foreground, blocking
arisa start              # start in background
arisa stop               # stop background service
arisa status             # show background service status
arisa flush              # remove ~/.arisa
arisa --silent           # run without verbose logs
```

Runtime model override (current process only):

```bash
arisa --agent.runtime prime --prime.model lmstudio/google/gemma-4-26b-a4b
```

Notes:

- it only affects the current Arisa process and does not update `~/.arisa/state/config.json`
- `--pi.*` remains a deprecated alias for `--prime.*` while the Prime runtime is active

## Prime migration and rollback

New installs use `agent.runtime: "prime"`. Existing installs remain on Pi until
that setting is changed, so one pilot chat can be validated before changing the
default service configuration. During this transition:

- Prime configuration, auth, and kernels live in `~/.arisa/state/prime-agent/`
- Prime chat sessions live in `state/prime-sessions/<revision>/`
- existing `state/pi-sessions/` JSONL files remain untouched
- the first Prime session creates a bounded, secret-sanitized handoff from the
  latest Pi session when possible
- setting `agent.runtime` back to `"pi"` rolls back to the preserved Pi runtime
- Prime schedules and heartbeats are not exposed; Arisa remains the source of
  truth for Telegram, tools, artifacts, tasks, and polling

Prime stays alive per active chat and closes after 90 idle minutes by default.
An RPC crash during a turn is reported as an interruption; Arisa does not claim
that work continued after the process was lost.

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
  runtimes/
    prime-agent/<version>/  verified managed Prime release
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
- Prime Agent v0.7.0 RPC integration, with temporary Pi rollback support
- artifact-based message handling
- the isolated CLI tool registry (starts empty)
- pre-reasoning and post-reasoning pipes
- queued follow-up message batching

Concrete capabilities such as audio transcription or text-to-speech are not built in; they are added as tools from the catalog (or built on demand) when a request needs them.

Future capabilities should be added as new tools and pipes, not as tightly coupled one-off code paths.
