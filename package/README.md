# Arisa

[Arisa](https://arisa.sh) is a personal Telegram assistant powered by [Pi Agent](https://pi.dev).

## Origin

The initial inspiration was OpenClaw, which has interesting ideas but carries a lot of weight (about **85 MB**, **55 dependencies**) compared to Arisa (**37 kB**, **3 dependencies**): when it generates tools they end up disorganized, and the overall framework feels overloaded.

The real heart of OpenClaw is Pi Agent: a [minimal terminal coding harness](https://www.youtube.com/watch?v=Dli5slNaJu0) that lets an AI agent reason and act with very little infrastructure. That part is genuinely good.

Telegram bots, on the other hand, work extremely well as a human interface. Simple, reliable, always in your pocket.

So Arisa keeps exactly those two things (Pi Agent & Telegram) and nothing more. No pre-loaded opinions about what the agent should do or which tools it should have. The idea is that the agent builds itself around the user, not the other way around.

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

A fresh install ships with **zero tools**. The core is only Telegram transport, the Pi Agent reasoning loop, the artifact store, and the tool registry. Out of the box Arisa cannot transcribe audio, browse the web, or speak; it gains each capability only once a tool that provides it is installed.

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
- audio/voice messages are transcribed first when a transcription tool is installed, then passed to Pi Agent as text; otherwise Arisa offers to install one
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
- all runtime state lives under `~/.arisa/`
- Telegram runtime config is stored in `~/.arisa/state/config.json`
- artifact index is stored in `~/.arisa/state/artifacts.json`
- incoming Telegram attachments are stored directly in `~/.arisa/artifacts/`
- tool-specific secrets/config live in `~/.arisa/tools/<tool>/config.js`
- user-created tools also live under `~/.arisa/tools/<tool>/`
- tool runtime temp files and generated outputs live under `~/.arisa/tools/<tool>/` (for example `tmp/` and `out/`)
- durable files should end up in `~/.arisa/artifacts/`
- Pi authentication can use either:
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

Command modes:

```bash
arisa                    # foreground, blocking
arisa start              # start in background
arisa stop               # stop background service
arisa status             # show background service status
arisa flush              # remove ~/.arisa
```

Runtime model override (current process only):

```bash
arisa --pi.model lmstudio/google/gemma-4-26b-a4b
```

Notes:

- it only affects the current Arisa process and does not update `~/.arisa/state/config.json`

## Bootstrap flow

On first run, Arisa will:

1. ask for a Telegram bot token
2. ask for the maximum number of authorized chat ids
3. show Pi providers discovered from Pi Agent's model registry
4. show the models available for the selected provider
5. resolve authentication for the selected Pi provider
6. validate that Pi Agent works
7. only then start listening to Telegram

### Non-interactive bootstrap (CLI overrides)

You can skip the interactive questions by providing `--telegram.token` and optional overrides:

```bash
node src/index.js --telegram.token <token>
```

With this mode, Arisa creates `~/.arisa/state/config.json` without prompts and applies these defaults when not provided:

- `pi.provider`: `openai-codex` when available, otherwise first provider from the current Pi provider list
- `pi.model`: first model after bootstrap sorting (currently prioritizes `openai-codex/gpt-5.5`)
- `telegram.maxChatIds`: `1`

Supported overrides:

```bash
node src/index.js --telegram.token <token> --telegram.maxChatIds 3 --pi.provider openai-codex --pi.model gpt-5.5 --pi.apiKey <optional-provider-key>
```

Notes:

- interactive bootstrap remains unchanged when no CLI overrides are provided
- `--bootstrap` can be combined with overrides to regenerate config non-interactively
- when `--pi.apiKey` is omitted and the provider supports OAuth, Arisa starts a temporary web page on `PORT` (default `10000`) where you can complete authentication from any browser
- unknown `--pi.provider` or `--pi.model` values are ignored and replaced by safe defaults

Telegram bot tokens can be created with:

- https://t.me/BotFather

## Using Pi authentication

For providers with internal Pi login support, such as Codex, leaving the API key empty during bootstrap will start the internal login flow automatically if no existing auth is found.

For example, selecting:

- `openai-codex/gpt-5.5`

allows Arisa to authenticate through Pi's Codex OAuth flow instead of requiring a normal OpenAI API key.

## Running model

Arisa keeps one Pi session per authorized Telegram chat.

If a message arrives while Pi Agent is still processing another one:

- the current message keeps running
- the new message is appended to a queued buffer
- additional incoming messages are concatenated to that same buffer
- once the current processing finishes, the buffered messages are sent together as the next prompt

Conceptually:

```txt
message 1 is processing
message 2 arrives -> queued
message 3 arrives -> appended to queued
message 1 finishes
queued batch is processed next
```

## Project structure

```txt
src/
  runtime/      bootstrap + app startup
  transport/    Telegram integration
  core/         agent, tools, artifacts, config
~/.arisa/
  state/
  artifacts/
  tools/        installed tools (catalog, user-chosen, or agent-created)
  tmp/
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

- `AGENTS.md` defines the project-level behavioral rules for Pi Agent
- `src/transport/telegram/bot.js` builds the per-message runtime prompt
- tool help is part of the architecture and should be consulted before use when details are unclear

## Status

This is currently a functional V1. The core provides:

- Telegram transport
- Pi Agent integration
- artifact-based message handling
- the isolated CLI tool registry (starts empty)
- pre-reasoning and post-reasoning pipes
- queued follow-up message batching

Concrete capabilities such as audio transcription or text-to-speech are not built in; they are added as tools from the catalog (or built on demand) when a request needs them.

Future capabilities should be added as new tools and pipes, not as tightly coupled one-off code paths.
