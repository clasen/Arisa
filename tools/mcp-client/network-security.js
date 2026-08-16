import dns from "node:dns/promises";
import net from "node:net";

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

function privateIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateIpv4(mapped[1]) : false;
}

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
}

export async function validateRemoteUrl(value, { allowPrivateHosts = false } = {}) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("Remote MCP URLs must use HTTPS");
  if (url.username || url.password) throw new Error("Credentials are not allowed in MCP URLs");
  if (!url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) throw new Error("Local MCP hosts are not allowed");
  if (!allowPrivateHosts) {
    const literal = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!literal.length || literal.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Private, loopback, or unresolved MCP hosts are not allowed");
    }
  }
  return url;
}

export function createSecureFetch({ allowPrivateHosts = false, timeoutMs = 120000, maxResponseBytes = 10485760 } = {}) {
  return async function secureFetch(input, init = {}) {
    const url = await validateRemoteUrl(input instanceof Request ? input.url : input, { allowPrivateHosts });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(url, { ...init, signal, redirect: "error" });
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxResponseBytes) {
      await response.body?.cancel();
      throw new Error(`Remote response exceeds the ${maxResponseBytes}-byte limit`);
    }
    return response;
  };
}
