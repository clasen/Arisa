# Magnific MCP

Specialized image-upscale adapter over the chat-scoped `mcp-client` Magnific profile.

## Generation flow

1. `generate` sends the requested model, prompt, aspect ratio, and count directly to Magnific without a balance or cost preflight. The user's request is sufficient authorization.
2. The job and creation identifiers are persisted by chat before the tool returns.
3. A finite set of independently scheduled `watch-generation` checks survives conversation steering and does not depend on a self-rescheduling chain.
4. The first terminal check atomically claims the job notification, cancels its remaining pending checks, and emits one agent event instructing Arisa to run `collect-generation` with delivery enabled for every undelivered index. Concurrent terminal checks cannot emit duplicate events.
5. Each collection records a fail-closed delivery attempt before returning the artifact. An uncertain delivery is never retried automatically.

Jobs expire after 24 hours. Watch tasks are bound to a random job token, so stale or cross-job callbacks cannot inspect or deliver another generation.

## Upscale flow

1. `balance` and `modes` are read-only.
2. `prepare-upscale` accepts a JPEG, PNG, or WebP artifact, uploads it as a hidden working asset, and validates the requested parameters without balance or cost preflights.
3. `upscale` starts exactly one prepared upscale without an extra confirmation round-trip, waits for completion, records asset egress, and returns the resulting image as an Arisa artifact.

Preparations expire after one hour and are single-use. Preparing creates a hidden source asset in the connected Magnific account but does not run the upscaler.

Supported modes are `creative`, `ultra-sublime`, `ultra-photo`, `ultra-denoiser`, and `ultra`. The latter three support only 2x according to Magnific's current MCP schema.
