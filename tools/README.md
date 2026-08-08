# Tools

This is the official Arisa tool catalog. Each subdirectory is a self-contained tool that Arisa can install into `~/.arisa/tools/<tool-name>` and invoke. Tools communicate through a standard `tool.manifest.json` contract and expose a single `index.js` entry point.

## Overview

| Tool | Function | Input | Output | Requires | Install footprint |
|------|----------|-------|--------|----------|-------------------|
| [`audio-extractor`](./audio-extractor/) | Extracts and normalizes audio from video or audio media via ffmpeg | audio + video | `audio/wav`, `audio/mpeg` | ffmpeg + ffprobe | Medium — 0 npm deps + external binaries |
| [`campaign-draft-runner`](./campaign-draft-runner/) | Discovers and verifies public editorial contacts, filters prior recipients, researches coverage, and creates profile-driven Gmail drafts without sending | `text/plain`, `application/json` | `application/json`, `text/plain` | `pr-campaign`, `gmail-workspace`, and optionally `web-browser` | Medium — 0 npm deps + Gmail setup |
| [`context-vault`](./context-vault/) | Stores, searches, updates, and forgets chat-scoped user context and preferences | `text/plain`, `application/json` | `text/plain`, `application/json` | - | Low — 1 npm dep |
| [`file-document`](./file-document/) | Returns an existing local file as a document artifact | `text/plain` | `text/markdown`, `text/plain`, `application/octet-stream` | - | Low — 0 npm deps |
| [`gmail-workspace`](./gmail-workspace/) | Reads, searches, sends, and manages Gmail through Google Workspace CLI using OAuth/API credentials | `text/plain`, `application/json` | `text/plain`, `application/json` | Google Workspace OAuth/API credentials | Medium — 1 npm dep + OAuth setup |
| [`markdown-pdf`](./markdown-pdf/) | Converts Markdown documents to PDF with pdfmake | `text/markdown`, `text/plain`, `application/json` | `application/pdf` | - | Medium — 4 npm deps |
| [`openai-transcribe`](./openai-transcribe/) | Transcribes audio files and video audio tracks via the OpenAI audio transcription API | audio + video | `text/plain` | `OPENAI_API_KEY` | Low — 0 npm deps |
| [`openai-tts`](./openai-tts/) | Converts text into OGG speech audio via the OpenAI TTS API | `text/plain` | `audio/ogg` | `OPENAI_API_KEY` | Low — 0 npm deps |
| [`pr-campaign`](./pr-campaign/) | Manages personalized PR outreach, contact history, drafts, daily caps, and follow-ups | `text/plain`, `application/json` | `application/json`, `text/plain` | `gmail-workspace` for Gmail drafts and sends | Medium — 0 npm deps + Gmail setup for email actions |
| [`video-analyze`](./video-analyze/) | Creates an evenly sampled video contact sheet and JSON timing manifest | video | `application/zip` | ffmpeg + ffprobe | Medium — 0 npm deps + external binaries |
| [`signaling-server`](./signaling-server/) | Runs a minimal public WebRTC signaling service with in-memory rooms | `text/plain`, `application/json` | `application/json` | Public WebSocket endpoint | Medium — 1 npm dep + daemon |
| [`roster-sites`](./roster-sites/) | Manages and publishes HTTPS sites through RosterServer (start/stop daemon, init, publish, list, DNS) | text + HTML | `application/json` | Public VPS + DNS + ports 80/443 (Let's Encrypt) | Medium — 2 npm deps + RosterServer daemon |
| [`schedule-agent-task`](./schedule-agent-task/) | Schedules future agent tasks (one-shot or recurring) through the async task queue | `text/plain` | `application/json` | - | Low — 0 npm deps |
| [`site-builder`](./site-builder/) | Generates or audits landing, portfolio, and static-site briefs using bundled frontend design guidance | `text/plain`, `text/markdown`, `application/json` | `text/html`, `text/markdown`, `application/json` | - | Low — 0 npm deps |
| [`turn-server`](./turn-server/) | Runs a coturn TURN relay daemon for WebRTC fallback connectivity | `text/plain`, `application/json` | `application/json` | coturn + public UDP/TCP port 3478 | High — external server binary + daemon |
| [`stop-slop-writer`](./stop-slop-writer/) | Prepares and audits prose requests using bundled stop-slop writing guidance | `text/plain`, `text/markdown`, `application/json` | `text/markdown`, `application/json` | - | Low — 0 npm deps |
| [`url-to-markdown`](./url-to-markdown/) | Fetches a URL as readable Markdown and returns it as a document file | `text/plain`, `application/json` | `text/markdown` | - | Low — 0 npm deps |
| [`video-downloader`](./video-downloader/) | Downloads videos from YouTube, TikTok, Instagram, Facebook, X/Twitter, and similar yt-dlp supported URLs | `text/plain` | `video/mp4` | yt-dlp + ffprobe | Medium — 0 npm deps + external binaries |
| [`web-browser`](./web-browser/) | Searches the web and fetches pages as readable text | `text/plain` | `text/plain` | - | Low — 0 npm deps |
| [`web-pentest-auditor`](./web-pentest-auditor/) | Performs non-destructive security audits of authorized web targets | `text/plain`, `application/json` | `text/markdown`, `application/json` | Authorized target | Low — 0 npm deps |
| [`whatsapp-web`](./whatsapp-web/) | Sends and receives WhatsApp messages via WhatsApp Web (login, send, broadcast, inbox, watch) | text + media | `text/plain`, `application/json` | Chrome/Chromium | High — 3 npm deps + Chrome/Chromium + QR login |
| [`whispermix-transcribe`](./whispermix-transcribe/) | Transcribes audio locally with WhisperMix; keeps the model warm via a persistent daemon | `audio/ogg`, `mp3`, `wav`, `mp4` | `text/plain` | Local WhisperMix install | High — 1 npm dep + local WhisperMix model + daemon |
| [`x-campaign-runner`](./x-campaign-runner/) | Discovers and ranks evidence-backed X outreach candidates, validates DM availability, and persists one tamper-resistant approval at a time | `text/plain`, `application/json` | `text/plain`, `application/json` | `x-dm`, web research, X/Twitter session | High — browser-backed discovery and approval workflow |
| [`x-dm`](./x-dm/) | Audits X outreach and sends one explicitly approved DM with campaign tracking, locking, caps, idempotency, and verified browser delivery | `text/plain`, `application/json` | `text/plain`, `application/json` | X/Twitter session cookies + Chromium | High — 1 npm dep + browser session |
| [`x-session-reader`](./x-session-reader/) | Reads posts and bookmarks visible through a user-provided X/Twitter session | `text/plain`, `application/json` | `text/plain`, `application/json`, `text/markdown`, `text/csv` | X/Twitter session cookies + Chromium | High — 1 npm dep + browser session |

**Install footprint guides autonomy.** Low-footprint tools (no extra npm dependencies, no external binaries) can be installed and used within the same request without asking the user first. Medium/High-footprint tools (heavy dependency trees, external binaries, or interactive setup such as a login) should be proposed to the user for confirmation before installing. A missing config secret (for example an API key) is handled by the normal missing-config flow and is not, on its own, a reason to ask before installing.

Tools that execute deterministic logic over skill content must vendor the required skill assets inside the tool package. `skillHints` remains advisory metadata for the agent and registry; it must not be the only runtime source for tool behavior.

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
