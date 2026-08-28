import dns from "node:dns/promises";
import net from "node:net";

function ipv4Number(address) {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function blockedIpv4(address) {
  return [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
    ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4]
  ].some(([base, prefix]) => inIpv4Range(address, base, prefix));
}

function ipv6BigInt(address) {
  let value = address.toLowerCase().split("%")[0];
  const ipv4 = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4) {
    const number = ipv4Number(ipv4);
    value = `${value.slice(0, -ipv4.length)}${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) throw new Error("Invalid IPv6 address.");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) throw new Error("Invalid IPv6 address.");
  return parts.reduce((result, part) => (result << 16n) + BigInt(`0x${part || "0"}`), 0n);
}

function inIpv6Range(address, base, prefix) {
  const bits = 128n - BigInt(prefix);
  return (ipv6BigInt(address) >> bits) === (ipv6BigInt(base) >> bits);
}

function blockedIpv6(address) {
  if (inIpv6Range(address, "::ffff:0:0", 96)) {
    const mapped = Number(ipv6BigInt(address) & 0xffffffffn);
    return blockedIpv4(`${mapped >>> 24}.${mapped >>> 16 & 255}.${mapped >>> 8 & 255}.${mapped & 255}`);
  }
  return [
    ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
    ["ff00::", 8], ["2001:db8::", 32]
  ].some(([base, prefix]) => inIpv6Range(address, base, prefix));
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family === 6) return blockedIpv6(address);
  return true;
}

export function parsePublicHttpUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("A valid absolute public HTTP(S) URL is required.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs are supported.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  if (!url.hostname || url.hostname.toLowerCase() === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("Localhost URLs are not allowed.");
  }
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && isBlockedAddress(literal)) throw new Error("Private or non-public network addresses are not allowed.");
  return url;
}

export async function validatePublicUrl(input, { lookup = dns.lookup } = {}) {
  const url = parsePublicHttpUrl(input);
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(literal)
    ? [{ address: literal }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error("The URL resolves to a private or non-public network address.");
  }
  return url;
}
