export default {
  port: "8787",
  basePath: "/signaling",
  publicBaseUrl: "http://localhost:8787/signaling",
  maxRooms: 1000,
  maxPeersPerRoom: 32,
  maxMessageBytes: 64 * 1024,
  roomIdleTtlMs: 5 * 60 * 1000,
  peerHeartbeatMs: 30 * 1000,
  stunUrls: ["stun:stun.l.google.com:19302"],
  turnUrls: [],
  turnSecret: "",
  turnTtlSeconds: 3600,
  turnUsername: "",
  turnCredential: ""
};
