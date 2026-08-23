# MCP Client

Chat-scoped client for remote MCP servers over Streamable HTTP.

## Actions

- `register`: store an allowlisted HTTPS endpoint as a profile.
- `profiles`: list profiles without credentials.
- `probe`: inspect public OAuth metadata.
- `oauth-start`: dynamically register a public OAuth client when needed, start device authorization, and schedule a finite set of independent checks until expiry.
- `oauth-poll`: manually finish a pending device authorization when needed.
- `tools`: authenticate and return `tools/list` schemas.
- `call`: execute one named remote tool. Requires `confirm=true`.
- `<remote tool name>`: execute any discovered tool directly with its arguments. The live MCP catalog is authoritative, so upstream additions need no client release.
- `remove`: remove the profile and encrypted local credentials.

Tool discovery, exact-name validation, JSON argument conversion, result normalization, size limits, and standard embedded image/audio/video materialization are generic client responsibilities. Provider adapters should delegate these operations and retain only provider-specific orchestration and artifact resolution.

## Security

Profiles and credentials are scoped to the requesting chat. OAuth credentials are encrypted with AES-256-GCM using a generated infrastructure key stored with mode `0600`. Output never includes access tokens, refresh tokens, client secrets, or device codes.

Remote endpoints must use HTTPS. Loopback, link-local, and private network addresses are rejected unless `ALLOW_PRIVATE_HOSTS` is explicitly enabled. Redirects are rejected, requests have bounded durations, declared response sizes are checked, and remote tool calls require explicit confirmation because they may consume credits or cause side effects.

The independent OAuth checks are bound to one authorization id. Stale checks stop without touching a newer authorization, and successful detection emits one agent event. This avoids depending on a fragile self-rescheduling chain.

The first release supports remote Streamable HTTP MCP servers and OAuth device authorization. It does not support local stdio servers or arbitrary shell commands.
