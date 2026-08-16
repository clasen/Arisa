import dns from "node:dns/promises";
import net from "node:net";

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const value = address.toLowerCase().split("%")[0];
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
}

export async function publicHttpsUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Magnific transfer URL must be public HTTPS");
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Magnific transfer URL resolved to a private address");
  return url;
}

export async function transfer(urlValue, init, timeoutMs = 120000) {
  const url = await publicHttpsUrl(urlValue);
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Magnific file transfer failed with HTTP ${response.status}`);
  return response;
}
