# Tools

Each subdirectory is a self-contained tool that Arisa can invoke. Tools communicate through a standard `tool.manifest.json` contract and expose a single `index.js` entry point.

## Overview

| Tool | Function | Input | Output | Requires |
|------|----------|-------|--------|----------|
| [`summarize`](./summarize/) | Summarizes URLs, YouTube videos, podcasts, and files via `steipete/summarize` | `text/plain` (URL or path) | `text/plain` | Optional: any LLM API key |
| [`whatsapp-web`](./whatsapp-web/) | Sends and receives WhatsApp messages via WhatsApp Web (login, send, broadcast, inbox, watch) | text + media | `text/plain`, `application/json` | Chrome/Chromium |
| [`whispermix-transcribe`](./whispermix-transcribe/) | Transcribes audio locally with WhisperMix; keeps the model warm via a persistent daemon | `audio/ogg`, `mp3`, `wav`, `mp4` | `text/plain` | Local WhisperMix install |

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
