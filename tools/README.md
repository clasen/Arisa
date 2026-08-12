# Tools

This is the official Arisa tool catalog. Each subdirectory is a self-contained tool that Arisa can install into `~/.arisa/tools/<tool-name>` and invoke. Tools communicate through a standard `tool.manifest.json` contract and expose a single `index.js` entry point.

## Catalog

Each entry describes one tool on its own terms. Category and tags come directly from the tool's `tool.manifest.json` metadata.

### [`audio-extractor`](./audio-extractor/)

Extract and normalize audio from video or audio media with ffmpeg.

- **Category:** `media`
- **Tags:** `audio` · `essential` · `extract` · `ffmpeg` · `normalize` · `preprocessing` · `video`
- **Accepts:** common audio and video formats
- **Produces:** `audio/wav`, `audio/mpeg`
- **Setup:** ffmpeg and ffprobe
- **Install footprint:** **Medium**, external binaries and no npm dependencies

### [`campaign-draft-runner`](./campaign-draft-runner/)

Run profile-driven outreach batches that discover public editorial contacts, filter prior recipients, verify domains, research coverage, and create Gmail drafts. It never sends mail.

- **Category:** `communication`
- **Tags:** `campaign` · `contacts` · `discovery` · `drafts` · `gmail` · `polling` · `outreach` · `pr` · `research` · `personalization` · `configurable`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`, `text/plain`
- **Setup:** `pr-campaign`, `gmail-workspace`, and optional `web-browser`
- **Install footprint:** **Medium**, Gmail setup and no npm dependencies

### [`context-vault`](./context-vault/)

Store, search, update, and forget chat-scoped user context and preferences with hybrid multilingual semantic and lexical recall plus prior Pi session fallback.

- **Category:** `memory`
- **Tags:** `chat-scoped` · `contacts` · `context` · `essential` · `memory` · `multilingual` · `preferences` · `recall` · `remember` · `semantic-search` · `session-search`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/plain`, `application/json`
- **Setup:** none
- **Install footprint:** **High**, local embedding model, native SQLite dependency, and chat-scoped daemon

### [`file-document`](./file-document/)

Return an existing local file as a document artifact.

- **Category:** `artifact`
- **Tags:** `artifact` · `delivery` · `document` · `essential` · `file` · `local-file`
- **Accepts:** `text/plain`
- **Produces:** `text/markdown`, `text/plain`, `application/octet-stream`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`github-ops`](./github-ops/)

Check GitHub token and repository access or star a repository through the GitHub API without exposing credentials.

- **Category:** `developer`
- **Tags:** `github` · `git` · `repo` · `deployment` · `source`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`, `text/plain`
- **Setup:** `GITHUB_TOKEN`; optional `DEFAULT_REPO`
- **Install footprint:** **Low**, no npm dependencies

### [`gmail-workspace`](./gmail-workspace/)

Read, search, send, and manage Gmail through Google Workspace CLI with OAuth or API credentials. Browser cookies are not accepted.

- **Category:** `communication`
- **Tags:** `email` · `essential` · `gmail` · `inbox` · `polling` · `secretary` · `send` · `workspace`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/plain`, `application/json`
- **Setup:** Google Workspace OAuth or API credentials
- **Install footprint:** **Medium**, one npm dependency and interactive OAuth setup

### [`markdown-pdf`](./markdown-pdf/)

Convert Markdown to PDF with support for headings, emphasis, links, code, blockquotes, lists, tables, images, rules, and footnotes.

- **Category:** `document`
- **Tags:** `artifact` · `document` · `export` · `markdown` · `pdf` · `render`
- **Accepts:** `text/markdown`, `text/plain`, `application/json`
- **Produces:** `application/pdf`
- **Setup:** none
- **Install footprint:** **Medium**, four npm dependencies

### [`official-tool-sync`](./official-tool-sync/)

Compare installed official tools with the catalog and safely apply non-conflicting updates while preserving configuration and local additions.

- **Category:** `developer`
- **Tags:** `catalog` · `compare` · `developer` · `essential` · `official` · `sync` · `tools` · `update` · `upgrade`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`, `text/plain`
- **Setup:** `trash`
- **Install footprint:** **Low**, no npm dependencies

### [`openai-transcribe`](./openai-transcribe/)

Transcribe audio files and video audio tracks through the OpenAI audio transcription API.

- **Category:** `transcription`
- **Tags:** `audio` · `essential` · `normalization` · `openai` · `speech-to-text` · `transcribe` · `video`
- **Accepts:** common audio and video formats
- **Produces:** `text/plain`
- **Setup:** `OPENAI_API_KEY`
- **Install footprint:** **Low**, no npm dependencies

### [`openai-tts`](./openai-tts/)

Convert text into OGG/Opus speech audio through the OpenAI speech API.

- **Category:** `speech`
- **Tags:** `audio` · `openai` · `speech` · `text-to-speech` · `tts` · `voice`
- **Accepts:** `text/plain`
- **Produces:** `audio/ogg`
- **Setup:** `OPENAI_API_KEY`
- **Install footprint:** **Low**, no npm dependencies

### [`pr-campaign`](./pr-campaign/)

Manage personalized PR outreach with contact history, email validation, DNS checks, drafts, daily caps, bounces, commercial offers, and follow-up eligibility.

- **Category:** `communication`
- **Tags:** `campaign` · `contacts` · `deliverability` · `email` · `follow-up` · `outreach` · `pr` · `press` · `verification`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`, `text/plain`
- **Setup:** `gmail-workspace` for Gmail draft and send actions
- **Install footprint:** **Medium**, Gmail setup and no npm dependencies

### [`roster-sites`](./roster-sites/)

Manage and publish small HTTPS sites through a global RosterServer daemon.

- **Category:** `deployment`
- **Tags:** `deployment` · `domain` · `essential` · `hosting` · `https` · `publish` · `roster` · `site`
- **Accepts:** `text/html`, `text/plain`, `application/json`
- **Produces:** `application/json`
- **Setup:** public VPS, DNS, and ports 80 and 443 for Let's Encrypt
- **Runtime:** global auto-start daemon
- **Install footprint:** **Medium**, two npm dependencies and a server daemon

### [`schedule-agent-task`](./schedule-agent-task/)

Schedule one-shot or recurring Pi Agent tasks through Arisa's async task queue.

- **Category:** `scheduler`
- **Tags:** `agent-task` · `async` · `essential` · `polling` · `reminder` · `schedule` · `task`
- **Accepts:** `text/plain`
- **Produces:** `application/json`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`signaling-server`](./signaling-server/)

Run a standalone WebRTC signaling service with public in-memory rooms.

- **Category:** `realtime`
- **Tags:** `daemon` · `rooms` · `server` · `signaling` · `webrtc` · `websocket`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`
- **Setup:** a public WebSocket endpoint
- **Runtime:** global auto-start daemon
- **Install footprint:** **Medium**, one npm dependency and a daemon

### [`site-builder`](./site-builder/)

Generate or audit landing-page, portfolio, and static-site briefs with bundled frontend design guidance.

- **Category:** `site`
- **Tags:** `audit` · `brief` · `design` · `frontend` · `html` · `landing-page` · `site-generator`
- **Accepts:** `text/plain`, `text/markdown`, `application/json`
- **Produces:** `text/html`, `text/markdown`, `application/json`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`stop-slop-writer`](./stop-slop-writer/)

Load the complete stop-slop writing guidance as editorial context for drafting and review.

- **Category:** `writing`
- **Tags:** `anti-slop` · `editing` · `markdown` · `prose` · `review` · `style` · `writing`
- **Accepts:** `text/plain`, `text/markdown`, `application/json`
- **Produces:** `text/markdown`, `application/json`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`trash`](./trash/)

Move files and directories into chat-scoped recoverable trash, restore mistakes, and report retained storage safely.

- **Category:** `filesystem`
- **Tags:** `delete` · `essential` · `filesystem` · `recover` · `restore` · `safety` · `storage` · `trash` · `undo`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`, `text/plain`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`turn-server`](./turn-server/)

Run a coturn TURN relay for WebRTC fallback connectivity.

- **Category:** `realtime`
- **Tags:** `coturn` · `daemon` · `networking` · `relay` · `server` · `turn` · `webrtc`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`
- **Setup:** coturn and public UDP/TCP port 3478
- **Runtime:** global auto-start daemon
- **Install footprint:** **High**, external server binary and daemon

### [`url-to-markdown`](./url-to-markdown/)

Fetch a URL as readable Markdown and return it as a document artifact.

- **Category:** `web`
- **Tags:** `document` · `essential` · `fetch` · `markdown` · `readability` · `url` · `web`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/markdown`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`video-analyze`](./video-analyze/)

Create a lightweight, evenly sampled video contact sheet and a JSON timing manifest. Audio transcription remains a separate pipe.

- **Category:** `media`
- **Tags:** `video` · `frames` · `contact-sheet` · `grid` · `ffmpeg` · `lightweight` · `analysis`
- **Accepts:** `video/*`
- **Produces:** `application/zip`
- **Setup:** ffmpeg and ffprobe
- **Install footprint:** **Medium**, external binaries and no npm dependencies

### [`video-downloader`](./video-downloader/)

Download videos from YouTube, TikTok, Instagram, Facebook, X/Twitter, and other sites supported by yt-dlp.

- **Category:** `media`
- **Tags:** `download` · `instagram` · `media` · `tiktok` · `twitter` · `video` · `youtube` · `yt-dlp`
- **Accepts:** `text/plain`
- **Produces:** `video/mp4`
- **Setup:** yt-dlp and ffprobe
- **Install footprint:** **Medium**, external binaries and no npm dependencies

### [`web-browser`](./web-browser/)

Search the web and open pages as readable text.

- **Category:** `web`
- **Tags:** `browse` · `essential` · `page` · `readability` · `research` · `search` · `web`
- **Accepts:** `text/plain`
- **Produces:** `text/plain`
- **Setup:** none
- **Install footprint:** **Low**, no npm dependencies

### [`web-pentest-auditor`](./web-pentest-auditor/)

Perform non-destructive security audits of authorized web targets, including headers, CORS, public API routes, auth behavior, source maps, and client-side clues.

- **Category:** `security`
- **Tags:** `audit` · `authorized` · `cors` · `headers` · `non-destructive` · `pentest` · `security` · `web`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/markdown`, `application/json`
- **Setup:** explicit authorization for the target
- **Install footprint:** **Low**, no npm dependencies

### [`whatsapp-web`](./whatsapp-web/)

Use isolated per-chat WhatsApp Web sessions to log in, send messages, and receive or process replies. A dedicated auxiliary number is recommended because browser automation can trigger Meta restrictions.

- **Category:** `communication`
- **Tags:** `contacts` · `daemon` · `essential` · `inbox` · `messaging` · `send` · `watch` · `whatsapp`
- **Accepts:** `text/plain`, `image/*`, `video/*`, `audio/*`, `application/pdf`
- **Produces:** `text/plain`, `application/json`
- **Setup:** Chrome or Chromium and WhatsApp login
- **Runtime:** chat-scoped on-demand daemon
- **Install footprint:** **High**, three npm dependencies, browser, and interactive login

### [`whispermix-transcribe`](./whispermix-transcribe/)

Transcribe audio locally with WhisperMix while a persistent daemon keeps the model warm.

- **Category:** `transcription`
- **Tags:** `audio` · `daemon` · `local` · `normalization` · `speech-to-text` · `transcribe` · `whisper`
- **Accepts:** `audio/ogg`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- **Produces:** `text/plain`
- **Setup:** local WhisperMix installation and model
- **Runtime:** global on-demand daemon
- **Install footprint:** **High**, one npm dependency, local model, and daemon

### [`x-campaign-runner`](./x-campaign-runner/)

Run profile-driven organic X outreach. It discovers evidence-backed candidates, excludes prior recipients, checks DM availability, personalizes one message, and persists one tamper-resistant approval at a time.

- **Category:** `social`
- **Tags:** `x` · `twitter` · `dm` · `campaign` · `discovery` · `outreach` · `personalization` · `dedupe` · `research`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `application/json`, `text/plain`
- **Setup:** `x-dm`, web research, and an X/Twitter session
- **Install footprint:** **High**, browser-backed discovery and approval workflow

### [`x-dm`](./x-dm/)

Manage X/Twitter outreach, follows, account profile changes, and explicitly confirmed posts with account pinning and post-change verification.

- **Category:** `social`
- **Tags:** `x` · `twitter` · `dm` · `message` · `outreach` · `campaign` · `playwright` · `cookies` · `social` · `profile` · `bio` · `post`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/plain`, `application/json`
- **Setup:** X/Twitter session cookies and Chromium
- **Install footprint:** **High**, one npm dependency and a persistent browser session

### [`x-reader`](./x-reader/)

Read recent public posts through the official X API without browser automation or session cookies.

- **Category:** `social`
- **Tags:** `api` · `posts` · `reader` · `social` · `twitter` · `x`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/plain`, `application/json`
- **Setup:** `X_BEARER_TOKEN`
- **Install footprint:** **Low**, no npm dependencies

### [`x-session-reader`](./x-session-reader/)

Read posts and bookmarks visible through a user-provided X/Twitter web session without bypassing login or anti-bot controls.

- **Category:** `social`
- **Tags:** `browser` · `cookies` · `playwright` · `bookmarks` · `download` · `export` · `posts` · `reader` · `session` · `social` · `twitter` · `x`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/plain`, `application/json`, `text/markdown`, `text/csv`
- **Setup:** X/Twitter session cookies and Chromium
- **Install footprint:** **High**, one npm dependency and a browser session

### [`youtube-transcript`](./youtube-transcript/)

Download YouTube subtitles with yt-dlp and return a plain-text or Markdown transcript.

- **Category:** `transcription`
- **Tags:** `youtube` · `transcript` · `subtitles` · `captions` · `yt-dlp` · `cookies` · `video`
- **Accepts:** `text/plain`, `application/json`
- **Produces:** `text/plain`, `text/markdown`
- **Setup:** yt-dlp; optional chat-scoped YouTube cookies
- **Install footprint:** **Medium**, external yt-dlp binary and no npm dependencies

**Install footprint guides autonomy.** Low-footprint tools can be installed and used within the same request without asking the user first. Medium and High-footprint tools require confirmation because they add external binaries, heavier dependency trees, daemons, or interactive setup. A missing secret follows the normal missing-config flow and does not by itself require installation approval.

Tools that execute deterministic logic over skill content must vendor the required skill assets inside the tool package. `skillHints` remains advisory metadata for the agent and registry; it must not be the only runtime source for tool behavior.

## Installing a tool

Tools are installed by copying the tool directory into `~/.arisa/tools/<tool-name>` and running `pnpm install` or `npm install` inside it. Catalog tools resolve Arisa core helpers at runtime through the `ARISA_PACKAGE_DIR` environment variable that Arisa provides when invoking tools.

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

The IPC client supports explicit capabilities only: tools, artifacts, tasks, agent events, and runtime paths. Chat-scoped calls require `chatId`.

## Tool contract

Every tool must have:

- **`tool.manifest.json`**: name, description, entry point, accepted input/output MIME types, config schema, category, and `keywords` used as discovery tags.
- **`index.js`**: the executable entry point. It must handle `--help` and `run --request-file <json>`.
- **`config.js`**: default config values merged with user-supplied secrets at runtime.
- **`package.json`**: isolated dependencies. Tools run in their own `node_modules`.

## Adding a tool

1. Create a new directory under `tools/`.
2. Add `tool.manifest.json` with at minimum `name`, `description`, `entry`, `input`, `output`, and `configSchema`. Add `category` and `keywords` so capability discovery can classify the tool.
3. Implement `index.js` following the `toolOk` and `toolError` result contract.
4. Add `config.js` with generic defaults. Keep user credentials empty.
5. Run `pnpm install` or `npm install` inside the tool directory.
