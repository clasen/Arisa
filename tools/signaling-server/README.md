# arisa-signaling-server

Daemon Arisa tool for minimal standalone WebRTC signaling with public, in-memory rooms.

The manifest declares the daemon entrypoint:

```json
{
  "daemon": {
    "command": "node index.js serve",
    "healthPath": "/signaling/health",
    "publicPath": "/signaling",
    "websocketPath": "/signaling/ws"
  }
}
```

## Run

```bash
cd tools/signaling-server
npm install
PORT=8787 npm start
```

Default endpoints:

- `GET /signaling`
- `GET /signaling/help`
- `GET /signaling/health`
- `GET /signaling/ice-servers`
- `GET /signaling/client.js`
- `WS /signaling/ws?room=ROOM&peer=PEER`

For `arisa.sh/signaling`, run this service behind the site/proxy and forward `/signaling/*` to the Node process.

## ICE servers

```js
const { iceServers } = await fetch("https://arisa.sh/signaling/ice-servers").then(r => r.json())
const pc = new RTCPeerConnection({ iceServers })
```

By default this returns a public STUN server. When `turnUrls` is empty, the daemon derives UDP and TCP TURN URLs from `publicBaseUrl` and reuses the managed `turn-server` secret when available. TURN can also be configured explicitly:

- `SIGNALING_TURN_URLS`
- `SIGNALING_TURN_USERNAME`
- `SIGNALING_TURN_CREDENTIAL`

## Protocol

Connect:

```js
const ws = new WebSocket("wss://arisa.sh/signaling/ws?room=my-room&peer=peer-a")
```

Server sends:

```json
{ "type": "joined", "room": "my-room", "peer": "peer-a", "peers": ["peer-b"] }
```

Presence events:

```json
{ "type": "peer-joined", "peer": "player-b" }
{ "type": "peer-left", "peer": "player-b" }
```

Relay to one peer:

```json
{ "type": "offer", "to": "player-b", "sdp": "..." }
{ "type": "answer", "to": "player-a", "sdp": "..." }
{ "type": "ice", "to": "player-b", "candidate": {} }
{ "type": "message", "to": "player-b", "data": { "ready": true } }
```

Relay to everyone else in the room by omitting `to`:

```json
{ "type": "broadcast", "data": { "kind": "ready" } }
```

Allowed relay types: `offer`, `answer`, `ice`, `candidate`, `signal`, `message`, `broadcast`.

## Browser helper

```html
<script src="https://arisa.sh/signaling/client.js"></script>
<script>
  const signaling = new ArisaSignaling({ room: 'my-room', peer: 'peer-a' })
  signaling.on('joined', ({ peers }) => console.log('existing peers', peers))
  signaling.on('message', ({ from, data }) => console.log(from, data))
  signaling.message({ hello: true }, 'player-b')
</script>
```

## Limits

Configured through env vars:

- `SIGNALING_MAX_ROOMS` default `1000`
- `SIGNALING_MAX_PEERS_PER_ROOM` default `32`
- `SIGNALING_MAX_MESSAGE_BYTES` default `65536`
- `SIGNALING_ROOM_IDLE_TTL_MS` default `300000`
- `SIGNALING_BASE_PATH` default `/signaling`
- `SIGNALING_PUBLIC_BASE_URL` default `https://arisa.sh/signaling`
