import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import defaults from "./config.js";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const toolName = "signaling-server";
const entryPath = fileURLToPath(import.meta.url);
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { getToolStateDir } = await importCore("runtime/paths.js");
const { isProcessAlive, readJson } = await importCore("core/tools/daemon-processes.js");
const daemon = createDaemonRuntime({ toolName, entryPath, autoStart: true });
const rooms = new Map();

function printHelp() {
  console.log(`signaling-server

Usage:
  node index.js serve [--port 8787] [--base-path /signaling]
  node index.js run --request-file <json>

Endpoints:
  GET  /signaling
  GET  /signaling/help
  GET  /signaling/health
  GET  /signaling/ice-servers
  GET  /signaling/client.js
  WS   /signaling/ws?room=ROOM&peer=PEER
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function normalizeBasePath(value) {
  const p = `/${String(value || "/signaling").replace(/^\/+|\/+$/g, "")}`;
  return p === "/" ? "" : p;
}

function safeId(value, fallback, maxLength) {
  const raw = String(value || fallback || "").trim();
  const clean = raw.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, maxLength);
  return clean || fallback;
}

function requestUrl(req) {
  return new URL(req.url || "/", "http://localhost");
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function roomSnapshot(room) {
  return [...room.peers.keys()];
}

function broadcast(room, payload, exceptPeer = null) {
  for (const [peer, client] of room.peers) {
    if (peer !== exceptPeer) send(client.ws, payload);
  }
}

function getRoom(roomId, config) {
  let room = rooms.get(roomId);
  if (!room) {
    if (rooms.size >= config.maxRooms) return null;
    room = { id: roomId, peers: new Map(), createdAt: Date.now(), lastEmptyAt: null };
    rooms.set(roomId, room);
  }
  return room;
}

function removePeer(client) {
  if (!client.roomId || !client.peerId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;
  const existing = room.peers.get(client.peerId);
  if (existing?.ws !== client.ws) return;
  room.peers.delete(client.peerId);
  broadcast(room, { type: "peer-left", peer: client.peerId }, client.peerId);
  if (room.peers.size === 0) room.lastEmptyAt = Date.now();
}

function pruneRooms(config) {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.peers.size === 0 && room.lastEmptyAt && now - room.lastEmptyAt > config.roomIdleTtlMs) {
      rooms.delete(id);
    }
  }
}

function error(ws, code, message) {
  send(ws, { type: "error", code, message });
}

function relay(room, from, msg, allowedTypes) {
  if (!allowedTypes.has(msg.type)) return false;
  const payload = { ...msg, from };
  delete payload.to;
  if (typeof msg.to === "string" && msg.to) {
    const target = room.peers.get(msg.to);
    if (!target) return false;
    send(target.ws, payload);
  } else {
    broadcast(room, payload, from);
  }
  return true;
}

function makeClientJs(basePath) {
  return `class ArisaSignaling extends EventTarget {\n  constructor({ url, room, peer } = {}) {\n    super();\n    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';\n    this.room = room || 'default';\n    this.peer = peer || crypto.randomUUID();\n    this.url = url || proto + '//' + location.host + '${basePath}/ws?room=' + encodeURIComponent(this.room) + '&peer=' + encodeURIComponent(this.peer);\n    this.ws = new WebSocket(this.url);\n    this.ws.addEventListener('message', (event) => {\n      let data;\n      try { data = JSON.parse(event.data); } catch { return; }\n      this.dispatchEvent(new CustomEvent(data.type, { detail: data }));\n      if (this['on' + data.type]) this['on' + data.type](data);\n    });\n    this.ws.addEventListener('open', () => this.dispatchEvent(new Event('open')));\n    this.ws.addEventListener('close', () => this.dispatchEvent(new Event('close')));\n  }\n  on(type, fn) { this.addEventListener(type, (event) => fn(event.detail)); return this; }\n  send(type, payload = {}) { this.ws.send(JSON.stringify({ type, ...payload })); }\n  offer(to, sdp) { this.send('offer', { to, sdp }); }\n  answer(to, sdp) { this.send('answer', { to, sdp }); }\n  ice(to, candidate) { this.send('ice', { to, candidate }); }\n  message(data, to) { this.send('message', { to, data }); }\n  broadcast(data) { this.send('broadcast', { data }); }\n}\nwindow.ArisaSignaling = ArisaSignaling;\n`;
}

async function hydrateTurnConfig(options) {
  const config = { ...options };
  if (!config.turnUrls?.length) {
    const host = new URL(config.publicBaseUrl).hostname;
    config.turnUrls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
  }
  if (!config.turnSecret && !config.turnUsername && !config.turnCredential) {
    try {
      config.turnSecret = (await readFile(path.join(getToolStateDir("turn-server"), "secret"), "utf8")).trim();
    } catch {}
  }
  return config;
}

function iceServers(config) {
  const servers = [];
  if (config.stunUrls?.length) servers.push({ urls: config.stunUrls });
  if (config.turnUrls?.length && config.turnSecret) {
    const username = String(Math.floor(Date.now() / 1000) + Number(config.turnTtlSeconds || 3600));
    const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
    servers.push({ urls: config.turnUrls, username, credential, credentialType: "password" });
  } else if (config.turnUrls?.length && config.turnUsername && config.turnCredential) {
    servers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnCredential, credentialType: "password" });
  }
  return servers;
}

function makeHelpText(config) {
  const wsUrl = `${config.publicBaseUrl.replace(/^http/, "ws")}/ws?room=my-room&peer=player-a`;
  const turn = iceServers(config).find((server) => String(server.urls).startsWith("turn:"));
  const turnInfo = turn
    ? `TURN relays:\n  ${[].concat(turn.urls).join("\n  ")}\n  Time-limited TURN credentials are included in the ICE response.\n`
    : "TURN relays: not configured.\n";
  return `Arisa Signaling API

A tiny public WebRTC signaling service for browsers, apps, experiments, calls, data channels, and peer-to-peer systems.
It does not carry application/audio/video traffic. It only relays signaling messages between peers in the same room.

Connect:
  const ws = new WebSocket("${wsUrl}")

ICE servers:
  const { iceServers } = await fetch("${config.publicBaseUrl}/ice-servers").then(r => r.json())
  const pc = new RTCPeerConnection({ iceServers })

${turnInfo}
Rooms:
  - A room is created automatically when the first peer joins.
  - Use ?room=ROOM to choose a room.
  - Use ?peer=PEER to choose a peer id. If omitted, one is generated.
  - Rooms are in memory and disappear after they become empty.

On connect, the server sends:
  { "type": "joined", "room": "my-room", "peer": "player-a", "peers": ["player-b"] }

Presence events:
  { "type": "peer-joined", "peer": "player-b" }
  { "type": "peer-left", "peer": "player-b" }

Send to one peer:
  { "type": "offer", "to": "player-b", "sdp": "..." }
  { "type": "answer", "to": "player-a", "sdp": "..." }
  { "type": "ice", "to": "player-b", "candidate": {} }
  { "type": "message", "to": "player-b", "data": { "ready": true } }

Broadcast to every other peer in the room by omitting "to":
  { "type": "broadcast", "data": { "kind": "ready" } }

Relayed messages include "from":
  { "type": "message", "from": "player-a", "data": { "ready": true } }

Allowed relay types:
  offer, answer, ice, candidate, signal, message, broadcast

Browser helper:
  <script src="${config.publicBaseUrl}/client.js"></script>
  <script>
    const signaling = new ArisaSignaling({ room: "my-room", peer: "player-a" })
    signaling.on("joined", ({ peers }) => console.log(peers))
    signaling.on("message", ({ from, data }) => console.log(from, data))
    signaling.message({ hello: true }, "player-b")
  </script>

Limits:
  max rooms: ${config.maxRooms}
  max peers per room: ${config.maxPeersPerRoom}
  max message bytes: ${config.maxMessageBytes}

Endpoints:
  GET ${config.basePath}
  GET ${config.basePath}/help
  GET ${config.basePath}/health
  GET ${config.basePath}/ice-servers
  GET ${config.basePath}/client.js
  WS  ${config.basePath}/ws?room=ROOM&peer=PEER
`;
}

function createServer(options = {}) {
  const config = { ...defaults, ...options };
  config.basePath = normalizeBasePath(config.basePath);
  config.port = Number(config.port || defaults.port);
  const wsPath = `${config.basePath}/ws`;
  const allowedRelayTypes = new Set(["offer", "answer", "ice", "candidate", "signal", "message", "broadcast"]);

  const server = http.createServer((req, res) => {
    const url = requestUrl(req);
    if (url.pathname === config.basePath || url.pathname === `${config.basePath}/`) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({
        name: "arisa-signaling",
        status: "ok",
        websocket: `${config.publicBaseUrl.replace(/^http/, "ws")}/ws`,
        client: `${config.publicBaseUrl}/client.js`,
        iceServers: `${config.publicBaseUrl}/ice-servers`,
        limits: { maxRooms: config.maxRooms, maxPeersPerRoom: config.maxPeersPerRoom, maxMessageBytes: config.maxMessageBytes },
        rooms: rooms.size
      }));
      return;
    }
    if (url.pathname === `${config.basePath}/help`) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      res.end(makeHelpText(config));
      return;
    }
    if (url.pathname === `${config.basePath}/health`) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    if (url.pathname === `${config.basePath}/ice-servers`) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      res.end(JSON.stringify({ iceServers: iceServers(config) }));
      return;
    }
    if (url.pathname === `${config.basePath}/client.js`) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      res.end(makeClientJs(config.basePath));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  server.on("upgrade", (req, socket, head) => {
    const url = requestUrl(req);
    if (url.pathname !== wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, url));
  });

  wss.on("connection", (ws, _req, url) => {
    const roomId = safeId(url.searchParams.get("room"), "default", 128);
    const peerId = safeId(url.searchParams.get("peer"), randomUUID(), 64);
    const client = { ws, roomId, peerId, alive: true };
    const room = getRoom(roomId, config);
    if (!room) {
      error(ws, "too_many_rooms", "Room limit reached");
      ws.close(1013, "too_many_rooms");
      return;
    }
    if (!room.peers.has(peerId) && room.peers.size >= config.maxPeersPerRoom) {
      error(ws, "room_full", "Room is full");
      ws.close(1013, "room_full");
      return;
    }
    if (room.peers.has(peerId)) {
      const old = room.peers.get(peerId);
      old.ws.close(4000, "peer_replaced");
    }

    const peersBeforeJoin = roomSnapshot(room).filter((peer) => peer !== peerId);
    room.peers.set(peerId, client);
    room.lastEmptyAt = null;
    send(ws, { type: "joined", room: roomId, peer: peerId, peers: peersBeforeJoin });
    broadcast(room, { type: "peer-joined", peer: peerId }, peerId);

    ws.on("pong", () => { client.alive = true; });
    ws.on("message", (buffer) => {
      let msg;
      try { msg = JSON.parse(buffer.toString("utf8")); } catch { error(ws, "bad_json", "Message must be JSON"); return; }
      if (!msg || typeof msg.type !== "string") { error(ws, "bad_message", "Message needs a type"); return; }
      if (msg.type === "ping") { send(ws, { type: "pong", t: Date.now() }); return; }
      if (msg.type === "leave") { ws.close(1000, "leave"); return; }
      const activeRoom = rooms.get(roomId);
      if (!activeRoom) { error(ws, "room_missing", "Room no longer exists"); return; }
      if (!relay(activeRoom, peerId, msg, allowedRelayTypes)) error(ws, "not_delivered", "Message was not delivered");
    });
    ws.on("close", () => removePeer(client));
    ws.on("error", () => removePeer(client));
  });

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const client of room.peers.values()) {
        if (!client.alive) { client.ws.terminate(); continue; }
        client.alive = false;
        client.ws.ping();
      }
    }
    pruneRooms(config);
  }, config.peerHeartbeatMs);
  heartbeat.unref();

  return {
    server,
    wss,
    config,
    async close() {
      clearInterval(heartbeat);
      for (const room of rooms.values()) {
        for (const client of room.peers.values()) client.ws.terminate();
      }
      rooms.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      wss.close();
    }
  };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
}

async function signalingHealth(config) {
  const response = await fetch(`http://127.0.0.1:${config.port}${config.basePath}/health`);
  if (!response.ok) throw new Error(`Signaling health returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.ok !== true) throw new Error("Signaling health response was not ok");
  return { message: "Signaling HTTP and event loop are healthy", rooms: body.rooms };
}

async function runDaemon() {
  let configOptions = await hydrateTurnConfig(await loadToolConfig(toolName, defaults));
  let active = createServer(configOptions);

  async function startServer() {
    await listen(active.server, active.config.port);
  }

  await startServer();
  await daemon.workLoop({
    processJob: async () => ({ port: active.config.port, basePath: active.config.basePath }),
    healthCheck: () => signalingHealth(active.config),
    recover: async () => {
      await active.close();
      configOptions = await hydrateTurnConfig(await loadToolConfig(toolName, defaults));
      active = createServer(configOptions);
      await startServer();
      return true;
    }
  });
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const args = request.args || {};
  const action = args.action || "status";
  if (action === "start") {
    const pid = await daemon.start();
    const status = await daemon.ensureReady();
    return console.log(JSON.stringify({ ok: true, output: { text: JSON.stringify({ pid, ...status }, null, 2), mimeType: "application/json" } }));
  }
  if (action === "stop") {
    await daemon.stop();
    return console.log(JSON.stringify({ ok: true, output: { text: "Signaling daemon stopped.", mimeType: "text/plain" } }));
  }
  const status = await readJson(daemon.paths.statusFile, { state: "stopped" });
  const pid = await daemon.getPid();
  console.log(JSON.stringify({
    ok: true,
    output: {
      text: JSON.stringify({
        name: "signaling-server",
        action,
        pid: pid || null,
        alive: isProcessAlive(pid),
        status,
        endpoints: ["GET /signaling", "GET /signaling/health", "GET /signaling/client.js", "WS /signaling/ws?room=ROOM&peer=PEER"],
        note: "Use action=start to start the managed daemon."
      }, null, 2),
      mimeType: "application/json"
    }
  }));
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv[0] === "help") {
  printHelp();
} else if (argv[0] === "daemon") {
  runDaemon().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
} else if (argv[0] === "serve") {
  const flags = parseArgs(argv.slice(1));
  const configOptions = await hydrateTurnConfig(await loadToolConfig(toolName, defaults));
  if (flags.port != null) configOptions.port = flags.port;
  if (flags["base-path"] != null) configOptions.basePath = flags["base-path"];
  const { server, config } = createServer(configOptions);
  server.listen(config.port, () => {
    console.log(`arisa-signaling listening on http://localhost:${config.port}${config.basePath}`);
  });
} else if (argv[0] === "run") {
  const i = argv.indexOf("--request-file");
  run(argv[i + 1]).catch((err) => console.log(JSON.stringify({ ok: false, error: err.message || String(err) })));
} else {
  printHelp();
}

export { createServer };
