# master-slave

Official global daemon tool for authenticated Arisa Master/Slave infrastructure.
The Master owns pairing, authorization, groups, batches and the inbound TCP
listener. A headless Slave reconnects outward, advertises a safe capability
profile, and executes only deterministic operations allowed by its stored policy.

## Safety contracts

- Bootstrap URLs accept only `tcp://` with an explicit literal IP, explicit port,
  and one 256-bit versioned secret path segment.
- Pairing secrets are retained only in the restrictive global state file until a
  handshake succeeds, are bound to one chat, expire after ten minutes, rotate on
  replacement, and are deleted on use. Public listings expose neither the secret
  nor its digest or claim token.
- Ed25519 identities and JSON state use atomic writes and mode `0600` inside mode
  `0700` directories.
- Handshake transcripts use ordered length-prefixed bytes under the domain
  `arisa-master-slave-handshake-v1`; they never rely on JSON key order.
- Encrypted frames use directional AES-256-GCM keys and nonce salts, authenticate
  version/type/sequence, and close their decoder after malformed, replayed,
  reordered, oversized, or unauthenticated input.
- Slave profiles and tool catalogs are allowlists. They expose configuration field
  names, declared requirement categories, and compact health state, never config
  values, environment variables, diagnostic messages, credentials, or log paths.
- Remote paths are resolved beneath explicitly granted roots with symlink escape
  protection. Commands use direct process spawning without a shell and enforce
  configured timeout and output limits.
- Accepted jobs are persisted before effects. Repeated job IDs return the stored
  terminal result, while interrupted accepted jobs fail closed instead of being
  executed again.
- Completed command results include bounded UTF-8 `stdout` and `stderr` assembled
  from the authenticated output stream, avoiding a second remote file read.

## Roles and configuration

Set `role` to `master` or `slave` in the global tool configuration. Master also
requires an IP-literal `listenHost`, a valid `listenPort`, and a canonical public
`tcp://IP:port` endpoint. There are no implicit network defaults. Operational
TTLs, limits, concurrency, reconnect timing, roots and capabilities live in
`config.js` and may be overridden by the installed tool configuration.
An unconfigured Slave running as root defaults to full-host access at `/` with
all v1 remote capabilities, including `process.exec`. A policy explicitly saved
through `configure_slave` replaces that root default.

The supported Slave service target is Linux with systemd. Use the Arisa CLI to
bootstrap and operate it:

```text
arisa slave tcp://198.51.100.12:4719/arisa_secret_v1_<secret>
arisa slave status
arisa slave log
arisa slave tools
arisa slave restart
arisa slave unpair
```

The bootstrap URL is a one-use credential. Do not log it or retain it after
pairing; passing it on a shell command line can leave it in shell history.

## CLI contract

```text
node index.js --help
node index.js run --request-file <json>
node index.js daemon
```

The daemon entry remains the transport owner. Public `run --request-file` calls
must submit through Arisa's managed daemon runtime rather than constructing a
second listener or client.
