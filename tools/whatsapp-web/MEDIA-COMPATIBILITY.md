# WhatsApp media compatibility

## Dependency installation

Run `pnpm install --frozen-lockfile` inside this tool. The lockfile pins the dependency graph; `pnpm-workspace.yaml` permits Puppeteer's required browser installation script. The postinstall step applies the existing WhatsApp ID compatibility fixes and the media backport idempotently. No core changes are needed.

## Media fix

The published whatsapp-web.js 1.34.7 download path calls `downloadAndMaybeDecrypt`. It threw an opaque `t` exception on two received voice messages in this deployment. Re-fetching the message and retrying this same path did not resolve it.

`media-compat.js` backports the upstream media resolution approach from commit `58ddf1561cd783d6a548fa812eb70a05944604b4` (whatsapp-web.js, Apache-2.0):

- https://github.com/pedroslopez/whatsapp-web.js/blob/58ddf1561cd783d6a548fa812eb70a05944604b4/src/structures/Message.js
- https://github.com/pedroslopez/whatsapp-web.js/blob/58ddf1561cd783d6a548fa812eb70a05944604b4/src/util/Injected/Utils.js

The tool continues calling the public `Message.downloadMedia()` API. The backport invokes WhatsApp's native download operation even for RESOLVED media, then reads the in-memory blob cache or the media object's blob. It does not implement its own decryption, fetch authenticated CDN URLs outside the session, or start a second browser client.

After this change, both previously failing real voice messages downloaded and transcribed successfully through the running managed worker. A fresh incoming voice message on 2026-09-27 at 21:27:37 UTC also arrived automatically with an audio artifact and a correct transcript, verifying the incoming normalization path.

## Failure handling

The media adapter owns bounded download retries. Audio normalization calls it once, without redundant history scans or an outer download retry loop. Transcription retries reuse the downloaded artifact. The inbox records completion/failure and the transcript. Exhausted failures are explicit, not fabricated transcripts. External outages, deleted media, unavailable media, and recognition errors remain possible.

## Maintenance

Run `node --test test/*.test.mjs`. On an upstream release with this fix, review and remove the backport rather than retaining duplicate logic. Unknown downloader implementations fail installation for review instead of silently receiving a speculative patch.
