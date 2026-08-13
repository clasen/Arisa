import net from "node:net";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { normalizeIpLiteral } from "./ip-address.js";

export const BOOTSTRAP_SECRET_PREFIX = "arisa_secret_v1_";
const SECRET_BYTES = 32;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function decodeSecret(encoded) {
  if (!BASE64URL_RE.test(encoded)) throw new Error("Bootstrap secret must use unpadded base64url");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== SECRET_BYTES || decoded.toString("base64url") !== encoded) {
    throw new Error("Bootstrap secret must contain exactly 256 bits");
  }
  return decoded;
}

export function decodeBootstrapSecret(secret) {
  const value = String(secret || "");
  if (!value.startsWith(BOOTSTRAP_SECRET_PREFIX)) throw new Error("Bootstrap secret version is invalid");
  return decodeSecret(value.slice(BOOTSTRAP_SECRET_PREFIX.length));
}

export function parseBootstrapUrl(value) {
  if (typeof value !== "string" || !value || value.trim() !== value || /\s/.test(value)) {
    throw new Error("Bootstrap URL must be one non-empty argument without whitespace");
  }
  if (!value.startsWith("tcp://")) throw new Error("Bootstrap URL scheme must be tcp");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid bootstrap URL");
  }
  if (parsed.protocol !== "tcp:") throw new Error("Bootstrap URL scheme must be tcp");
  if (parsed.username || parsed.password) throw new Error("Bootstrap URL must not contain user information");
  if (parsed.search) throw new Error("Bootstrap URL must not contain a query");
  if (parsed.hash) throw new Error("Bootstrap URL must not contain a fragment");
  if (!parsed.port) throw new Error("Bootstrap URL requires an explicit port");
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Bootstrap URL port is invalid");

  const authority = value.slice("tcp://".length, value.indexOf("/", "tcp://".length));
  const rawHost = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (net.isIP(rawHost) === 6 && !authority.startsWith("[")) {
    throw new Error("IPv6 bootstrap addresses must be bracketed");
  }
  if (!net.isIP(rawHost)) throw new Error("Bootstrap URL host must be an IP literal");

  if (!/^\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
    throw new Error("Bootstrap URL requires exactly one unescaped secret path segment");
  }
  const secret = parsed.pathname.slice(1);
  if (!secret.startsWith(BOOTSTRAP_SECRET_PREFIX)) throw new Error("Bootstrap secret version is invalid");
  const secretBytes = decodeBootstrapSecret(secret);
  const host = normalizeIpLiteral(rawHost);
  const endpointHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return {
    endpoint: `tcp://${endpointHost}:${port}`,
    host,
    port,
    secret,
    secretBytes
  };
}

export function createBootstrapSecret(randomBytes = nodeRandomBytes) {
  const bytes = randomBytes(SECRET_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== SECRET_BYTES) {
    throw new Error("Bootstrap random source must return exactly 32 bytes");
  }
  return `${BOOTSTRAP_SECRET_PREFIX}${bytes.toString("base64url")}`;
}
