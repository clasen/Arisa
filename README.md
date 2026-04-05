# Arisa

Arisa is a modular Telegram assistant powered by Pi Agent.

It is designed around a simple idea:

- **Telegram is the human interface**
- **Pi Agent is the reasoning engine**
- **everything is an artifact**
- **capabilities live in isolated CLI tools**
- **tools can be chained through pipes**

Arisa is meant to grow like Lego blocks. If a capability does not exist yet, the system should prefer adding a new tool instead of stopping at "I can't do that".

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
- Telegram runtime config is stored in `data/state/config.json`
- tool-specific secrets/config live in `cli/<tool>/config.js`
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
3. show a list of Pi models
4. resolve authentication for the selected Pi provider
5. validate that Pi Agent works
6. only then start listening to Telegram

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
data/
  state/
  artifacts/
  chats/
```

## Philosophy

Arisa should not default to passive answers like "I can't do that" when a missing capability can realistically be implemented as a new tool.

The preferred behavior is:

1. check whether an existing tool can solve the task
2. if not, propose creating the missing tool
3. keep the solution inside the tool architecture

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
