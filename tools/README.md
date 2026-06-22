# Tools

This is the official Arisa tool catalog. Each subdirectory is a self-contained tool that Arisa can install into `~/.arisa/tools/<tool-name>` and invoke. Tools communicate through a standard `tool.manifest.json` contract and expose a single `index.js` entry point.

## Overview

| Tool | Function | Input | Output | Requires | Install footprint |
|------|----------|-------|--------|----------|-------------------|
| [`audio-extractor`](./audio-extractor/) | Extracts and normalizes audio from video or audio media via ffmpeg | audio + video | `audio/wav`, `audio/mpeg` | ffmpeg + ffprobe | Medium — 0 npm deps + external binaries |
| [`context-vault`](./context-vault/) | Stores, searches, updates, and forgets chat-scoped user context and preferences | `text/plain`, `application/json` | `text/plain`, `application/json` | - | Low — 1 npm dep |
| [`openai-transcribe`](./openai-transcribe/) | Transcribes audio files and video audio tracks via the OpenAI audio transcription API | audio + video | `text/plain` | `OPENAI_API_KEY` | Low — 0 npm deps |
| [`openai-tts`](./openai-tts/) | Converts text into OGG speech audio via the OpenAI TTS API | `text/plain` | `audio/ogg` | `OPENAI_API_KEY` | Low — 0 npm deps |
| [`roster-sites`](./roster-sites/) | Manages and publishes HTTPS sites through RosterServer (start/stop daemon, init, publish, list, DNS) | text + HTML | `application/json` | Public VPS + DNS + ports 80/443 (Let's Encrypt) | Medium — 2 npm deps + RosterServer daemon |
| [`schedule-agent-task`](./schedule-agent-task/) | Schedules future agent tasks (one-shot or recurring) through the async task queue | `text/plain` | `application/json` | - | Low — 0 npm deps |
| [`video-downloader`](./video-downloader/) | Downloads videos from YouTube, TikTok, Instagram, Facebook, X/Twitter, and similar yt-dlp supported URLs | `text/plain` | `video/mp4` | yt-dlp + ffprobe | Medium — 0 npm deps + external binaries |
| [`web-browser`](./web-browser/) | Searches the web and fetches pages as readable text | `text/plain` | `text/plain` | - | Low — 0 npm deps |
| [`whatsapp-web`](./whatsapp-web/) | Sends and receives WhatsApp messages via WhatsApp Web (login, send, broadcast, inbox, watch) | text + media | `text/plain`, `application/json` | Chrome/Chromium | High — 3 npm deps + Chrome/Chromium + QR login |
| [`whispermix-transcribe`](./whispermix-transcribe/) | Transcribes audio locally with WhisperMix; keeps the model warm via a persistent daemon | `audio/ogg`, `mp3`, `wav`, `mp4` | `text/plain` | Local WhisperMix install | High — 1 npm dep + local WhisperMix model + daemon |

**Install footprint guides autonomy.** Low-footprint tools (no extra npm dependencies, no external binaries) can be installed and used within the same request without asking the user first. Medium/High-footprint tools (heavy dependency trees, external binaries, or interactive setup such as a login) should be proposed to the user for confirmation before installing. A missing config secret (for example an API key) is handled by the normal missing-config flow and is not, on its own, a reason to ask before installing.

## Installing a tool

Tools are installed by copying the tool directory into `~/.arisa/tools/<tool-name>` and running `pnpm install` (or `npm install`) inside it. Catalog tools resolve Arisa core helpers at runtime through the `ARISA_PACKAGE_DIR` environment variable that Arisa provides when invoking tools.

## Tool-to-Arisa IPC

Tools use local IPC when they need to call back into Arisa. Arisa does not discover or mount tool-provided web routes in core.

If a tool needs a web UI or HTTP endpoint, the tool should run its own server, usually from a daemon built with Arisa's shared daemon runtime. That server handles requests internally and uses IPC to access Arisa capabilities or run another registered tool.

Example IPC client usage from a tool:

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { createArisaClient } = await importCore("core/tools/ipc-client.js");

const arisa = createArisaClient({ toolName: "example-tool", chatId });
await arisa.artifacts.createText({ text: "hello" });
```

Tool-owned web servers can use `tools.run` for request/response interactions without adding core HTTP routes or proxies:

```js
const result = await arisa.tools.run({
  name: "strudel-agent",
  text: prompt,
  args: {
    bpm,
    tags,
    currentCode
  }
}, { timeoutMs: 120_000 });
```

The IPC client supports explicit capabilities only: tools (`run`), artifacts, tasks, agent events, and runtime paths. Chat-scoped calls require `chatId`.

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
