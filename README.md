# Arisa

Arisa is a personal Telegram assistant powered by Pi Agent.

## Origin

The initial inspiration was [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw has interesting ideas but carries too much weight: when it generates tools they end up disorganized, and the overall framework feels overloaded for personal use.

The real heart of OpenClaw is Pi Agent — a [minimal terminal coding harness](https://www.youtube.com/watch?v=Dli5slNaJu0) that lets an AI agent reason and act with very little infrastructure. That part is genuinely good.

Telegram bots, on the other hand, work extremely well as a human interface. Simple, reliable, always in your pocket.

So Arisa keeps exactly those two things — Pi Agent and Telegram — and nothing more. No pre-loaded opinions about what the agent should do or which tools it should have. The idea is that the agent builds itself around the user, not the other way around.

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

## Current behavior

### Telegram input
- text messages go directly to Pi Agent
- audio/voice messages are transcribed first, then passed to Pi Agent as text
- media is stored as artifacts

### Tool model
Each tool lives in its own folder under `cli/<tool-name>` and contains:

- `package.json`
- `config.js`
- `tool.manifest.json`
- `index.js`

Each tool is isolated from the root project and from other tools.
That isolation is part of the architecture:

- each tool has its own folder
- each tool keeps its own `config.js`
- each tool can have its own dependencies
- one tool can be changed or replaced without tightly coupling the rest of the system

Each tool must support:

```bash
node index.js --help
node index.js run --request-file <json>
```

### Configuration model
- all runtime state lives under `~/.arisa/`
- Telegram runtime config is stored in `~/.arisa/state/config.json`
- artifact index is stored in `~/.arisa/state/artifacts.json`
- incoming Telegram attachments are stored directly in `~/.arisa/artifacts/`
- tool-specific secrets/config live in `~/.arisa/tools/<tool>/config.js`
- tool runtime temp files and generated outputs live in `~/.arisa/tmp/tools/<tool>/`
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

## Bootstrap flow

On first run, Arisa will:

1. ask for a Telegram bot token
2. ask for the maximum number of authorized chat ids
3. show Pi providers discovered from Pi Agent's model registry
4. show the models available for the selected provider
5. resolve authentication for the selected Pi provider
6. validate that Pi Agent works
7. only then start listening to Telegram

Telegram bot tokens can be created with:

- https://t.me/BotFather

## Using Pi authentication

For providers with internal Pi login support, such as Codex, leaving the API key empty during bootstrap will start the internal login flow automatically if no existing auth is found.

For example, selecting:

- `openai-codex/gpt-5.4`

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
cli/
  openai-transcribe/
  openai-tts/
~/.arisa/
  state/
  artifacts/
  tools/
  tmp/
```

## Philosophy

The agent should not come preloaded with vices or assumptions. It starts minimal and grows through real use — shaped by the user, not by the framework.

When a capability is missing:

1. check whether an existing tool can solve the task
2. if not, build the missing tool
3. keep the solution inside the tool architecture

No "I can't do that" when the thing is realistically buildable.

## Notes

- `AGENTS.md` defines the project-level behavioral rules for Pi Agent
- `src/transport/telegram/bot.js` builds the per-message runtime prompt
- tool help is part of the architecture and should be consulted before use when details are unclear

## Status

This is currently a functional V1 focused on:

- Telegram transport
- Pi Agent integration
- artifact-based message handling
- isolated CLI tools
- audio transcription before reasoning
- text-to-speech replies
- queued follow-up message batching

Future capabilities should be added as new tools and pipes, not as tightly coupled one-off code paths.
