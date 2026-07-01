# turn-server

Daemon Arisa tool that runs `coturn` as a TURN fallback relay for WebRTC.

TURN is a backup path: browsers try direct peer-to-peer first using STUN; if NAT/firewall traversal fails, they can relay through TURN.

## Run

```bash
cd tools/turn-server
node index.js start
```

Public ports:

- `3478/udp`
- `3478/tcp`
- relay range: `49160-49200/udp`

The tool uses coturn REST API credentials:

- coturn stores a shared secret locally.
- `/signaling/ice-servers` generates short-lived WebRTC credentials using that secret.
- TURN is not open relay.

## Signaling integration

Start signaling with:

```bash
SIGNALING_TURN_URLS='turn:arisa.sh:3478?transport=udp,turn:arisa.sh:3478?transport=tcp' \
SIGNALING_TURN_SECRET='<same secret>' \
node tools/signaling-server/index.js serve
```

Then clients can use:

```js
const { iceServers } = await fetch('https://arisa.sh/signaling/ice-servers').then(r => r.json())
const pc = new RTCPeerConnection({ iceServers })
```
