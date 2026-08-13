import net from "node:net";

function parseIpv4(value) {
  if (net.isIP(value) !== 4) throw new Error(`Invalid IPv4 address: ${value}`);
  return value.split(".").map(Number);
}

function parseIpv6(value) {
  let source = String(value).toLowerCase();
  const zoneIndex = source.indexOf("%");
  if (zoneIndex !== -1) throw new Error("Scoped IPv6 addresses are not supported");
  if (net.isIP(source) !== 6) throw new Error(`Invalid IPv6 address: ${value}`);

  let ipv4Tail = null;
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    ipv4Tail = parseIpv4(tail);
    source = `${source.slice(0, lastColon)}:${((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16)}:${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) throw new Error(`Invalid IPv6 address: ${value}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error(`Invalid IPv6 address: ${value}`);
  }
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function renderIpv6(bytes) {
  const words = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart === -1) return words.map((word) => word.toString(16)).join(":");
  const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(":");
  const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(":");
  return `${left}::${right}`;
}

export function normalizeIpLiteral(value) {
  const source = String(value);
  if (net.isIP(source) === 4) return parseIpv4(source).join(".");
  const bytes = parseIpv6(source);
  const mapped = bytes.subarray(0, 10).every((byte) => byte === 0)
    && bytes.readUInt16BE(10) === 0xffff;
  if (mapped) return [...bytes.subarray(12)].join(".");
  return renderIpv6(bytes);
}

export function addressesEqual(left, right) {
  try {
    return normalizeIpLiteral(left) === normalizeIpLiteral(right);
  } catch {
    return false;
  }
}
