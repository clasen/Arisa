# Magnific MCP

Thin Magnific adapter over the chat-scoped `mcp-client` profile. Generic tool discovery, exact-name validation, argument conversion, invocation, result normalization, and standard embedded-media materialization belong to `mcp-client`. This adapter delegates those operations while retaining Magnific-specific image generation, upscale, reactive delivery, creation download, and duplicate-delivery safeguards.

Examples:

- `action=video_plan`, with the plan fields as arguments
- `action=video_generate`, with the complete upstream `video_generate` payload
- `action=audio_tts`, with `text`, `voiceId`, and optional model settings
- `action=call`, `tool=flows_run`, `arguments={...}`

## Generation flow

1. `generate` validates the requested model, prompt, aspect ratio, and count without a balance or cost preflight. The user's request is sufficient authorization.
2. When an image artifact is attached, the same call uploads it as a hidden working asset and binds that exact creation identifier as an `image` reference before starting generation. A failed upload prevents the paid generation call. Without an artifact, generation remains text-only.
3. The job, output identifiers, and reference provenance are persisted by chat before the tool returns.
4. A finite set of independently scheduled `watch-generation` checks survives conversation steering and does not depend on a self-rescheduling chain.
5. The first terminal check atomically claims the job notification, cancels its remaining pending checks, and emits one agent event instructing Arisa to run `collect-generation` with delivery enabled for every undelivered index. Concurrent terminal checks cannot emit duplicate events.
6. Each collection records a fail-closed delivery attempt before returning the artifact. An uncertain delivery is never retried automatically.

Jobs expire after 24 hours. Watch tasks are bound to a random job token, so stale or cross-job callbacks cannot inspect or deliver another generation.

## Upscale flow

1. `balance` and `modes` are read-only.
2. `prepare-upscale` accepts a JPEG, PNG, or WebP artifact, uploads it as a hidden working asset, and validates the requested parameters without balance or cost preflights.
3. `upscale` starts exactly one prepared upscale without an extra confirmation round-trip, waits for completion, records asset egress, and returns the resulting image as an Arisa artifact.
4. `download` reads the completed creation, preserves its HTTP media type and extension, records asset egress, and returns image, audio, or video output with the appropriate delivery hint.

Preparations expire after one hour and are single-use. Preparing creates a hidden source asset in the connected Magnific account but does not run the upscaler.

Supported modes are `creative`, `ultra-sublime`, `ultra-photo`, `ultra-denoiser`, and `ultra`. The latter three support only 2x according to Magnific's current MCP schema.
