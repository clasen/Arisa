import net from "node:net";

const SECRET_PATTERN = /^arisa_secret_v1_[A-Za-z0-9_-]{43}$/;

export function parseSlaveBootstrapUrl(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("Arisa Slave requires one TCP bootstrap URL");
  }
  if (/\s/.test(value)) throw new Error("Slave bootstrap URL must not contain whitespace");
  if (value.includes("?")) throw new Error("Slave bootstrap URL must not contain a query");
  if (value.includes("#")) throw new Error("Slave bootstrap URL must not contain a fragment");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid Slave bootstrap URL");
  }
  if (parsed.protocol !== "tcp:") throw new Error("Slave bootstrap URL must use tcp");
  if (parsed.username || parsed.password) throw new Error("Slave bootstrap URL must not contain user information");
  if (parsed.search) throw new Error("Slave bootstrap URL must not contain a query");
  if (parsed.hash) throw new Error("Slave bootstrap URL must not contain a fragment");
  if (!parsed.port) throw new Error("Slave bootstrap URL requires an explicit port");

  const authority = /^tcp:\/\/([^/]+)\//.exec(value)?.[1] || "";
  const ipv6Authority = /^\[([^\]]+)]:(\d+)$/.exec(authority);
  const ipv4Authority = /^([^:]+):(\d+)$/.exec(authority);
  const bracketed = Boolean(ipv6Authority);
  const host = ipv6Authority?.[1] || ipv4Authority?.[1] || "";
  const ipVersion = net.isIP(host);
  if (!ipVersion) throw new Error("Slave bootstrap URL requires an IPv4 or IPv6 literal");
  if (ipVersion === 6 && !bracketed) throw new Error("IPv6 Slave bootstrap addresses must be bracketed");

  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Slave bootstrap URL contains an invalid port");
  }
  const match = /^\/([^/]+)$/.exec(parsed.pathname);
  if (!match) throw new Error("Slave bootstrap URL requires exactly one secret path segment");
  const secret = match[1];
  if (!SECRET_PATTERN.test(secret)) throw new Error("Slave bootstrap URL contains an invalid connection secret");

  return {
    endpoint: `tcp://${ipVersion === 6 ? `[${host}]` : host}:${port}`,
    host,
    ipVersion,
    port,
    secret,
    url: value
  };
}
