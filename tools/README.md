# Tools

This is the official Arisa tool catalog. Each subdirectory is a self-contained tool that Arisa can install into `~/.arisa/tools/<tool-name>` and invoke. Tools communicate through a standard `tool.manifest.json` contract and expose a single `index.js` entry point.

## Overview

| Tool | Function | Input | Output | Requires | Install footprint |
|------|----------|-------|--------|----------|-------------------|
| [`openai-transcribe`](./openai-transcribe/) | Transcribes audio files and video audio tracks via the OpenAI audio transcription API | audio + video | `text/plain` | `OPENAI_API_KEY` | Low — 0 npm deps |
| [`openai-tts`](./openai-tts/) | Converts text into OGG speech audio via the OpenAI TTS API | `text/plain` | `audio/ogg` | `OPENAI_API_KEY` | Low — 0 npm deps |
| [`schedule-agent-task`](./schedule-agent-task/) | Schedules future agent tasks (one-shot or recurring) through the async task queue | `text/plain` | `application/json` | - | Low — 0 npm deps |
| [`summarize`](./summarize/) | Summarizes URLs, YouTube videos, podcasts, and files via `steipete/summarize` | `text/plain` (URL or path) | `text/plain` | Optional: any LLM API key | Medium — 1 npm dep (pulls a large toolchain) |
| [`web-browser`](./web-browser/) | Searches the web and fetches pages as readable text | `text/plain` | `text/plain` | - | Low — 0 npm deps |
| [`whatsapp-web`](./whatsapp-web/) | Sends and receives WhatsApp messages via WhatsApp Web (login, send, broadcast, inbox, watch) | text + media | `text/plain`, `application/json` | Chrome/Chromium | High — 3 npm deps + Chrome/Chromium + QR login |
| [`whispermix-transcribe`](./whispermix-transcribe/) | Transcribes audio locally with WhisperMix; keeps the model warm via a persistent daemon | `audio/ogg`, `mp3`, `wav`, `mp4` | `text/plain` | Local WhisperMix install | High — 1 npm dep + local WhisperMix model + daemon |

**Install footprint guides autonomy.** Low-footprint tools (no extra npm dependencies, no external binaries) can be installed and used within the same request without asking the user first. Medium/High-footprint tools (heavy dependency trees, external binaries, or interactive setup such as a login) should be proposed to the user for confirmation before installing. A missing config secret (for example an API key) is handled by the normal missing-config flow and is not, on its own, a reason to ask before installing.

## Installing a tool

Tools are installed by copying the tool directory into `~/.arisa/tools/<tool-name>` and running `pnpm install` (or `npm install`) inside it. Catalog tools import Arisa core helpers with the placeholder prefix `../../src/`; at install time that prefix must be rewritten to the absolute `src/` path of the local Arisa install. Arisa performs these steps itself when it proposes a tool from the catalog and the user confirms.

## Tool contract

Every tool must have:

- **`tool.manifest.json`** — name, description, entry point, accepted input/output MIME types, and config schema.
- **`index.js`** — the executable entry point. Must handle `--help` and `run --request-file <json>`.
- **`config.js`** — default config values merged with user-supplied secrets at runtime.
- **`package.json`** — isolated dependencies (tools run in their own `node_modules`).

## Adding a tool

1. Create a new directory under `tools/`.
2. Add `tool.manifest.json` with at minimum `name`, `description`, `entry`, `input`, `output`, and `configSchema`.
3. Implement `index.js` following the `toolOk` / `toolError` result contract.
4. Add `config.js` with any default values.
5. Run `pnpm install` inside the tool directory.
