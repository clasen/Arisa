import { boundUtf8, normalizeMaxOutputBytes } from "./output-bounds.js";
import { parsePublicHttpUrl, validatePublicUrl } from "./url-security.js";

const allowedModes = new Set(["open", "render", "extract-links"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function decodeAttribute(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeMode(value) {
  const mode = String(value || "open").trim().toLowerCase();
  if (!allowedModes.has(mode)) throw new Error(`Unsupported mode: ${mode}. Use open, render, or extract-links.`);
  return mode;
}

export function buildFetchArgs(url, mode, config = {}, args = {}) {
  const timeoutMs = boundedInteger(args.timeoutMs ?? config.TIMEOUT_MS, 30_000, 5_000, 60_000);
  const maxOutputBytes = normalizeMaxOutputBytes(args.maxOutputBytes ?? config.MAX_OUTPUT_BYTES);
  const dump = mode === "open" ? "markdown" : "html";
  const command = [
    "fetch", url.href,
    "--json",
    "--dump", dump,
    "--dump-max-bytes", String(mode === "extract-links" ? Math.min(1024 * 1024, maxOutputBytes * 4) : maxOutputBytes),
    "--block-private-networks",
    "--fail-on-http-error",
    "--http-connect-timeout", String(Math.min(10_000, timeoutMs)),
    "--http-timeout", String(Math.min(15_000, timeoutMs)),
    "--http-max-response-size", String(4 * 1024 * 1024),
    "--http-max-concurrent", "8",
    "--http-max-host-open", "4",
    "--terminate-ms", String(timeoutMs),
    "--watchdog-ms", String(Math.min(15_000, timeoutMs)),
    "--v8-max-heap-mb", "64",
    "--ws-max-concurrent", "2",
    "--log-level", "error"
  ];
  if (args.waitMs !== undefined) {
    command.push("--wait-ms", String(boundedInteger(args.waitMs, 3_000, 0, Math.min(15_000, timeoutMs))));
  } else if (args.waitUntil !== undefined) {
    const waitUntil = String(args.waitUntil).trim().toLowerCase();
    if (!new Set(["load", "domcontentloaded", "networkalmostidle", "networkidle", "done"]).has(waitUntil)) throw new Error("waitUntil is invalid.");
    command.push("--wait-until", waitUntil);
  } else if (!args.waitSelector) {
    command.push("--wait-ms", "3000");
  }
  if (config.OBEY_ROBOTS !== false) command.push("--obey-robots");
  if (args.stripUi === true || args.stripUi === "true") command.push("--strip-mode", "ui");
  if (args.selector) {
    const selector = String(args.selector);
    if (selector.length > 500) throw new Error("selector is too long.");
    command.push("--dump-selector", selector);
  }
  if (args.waitSelector) {
    const selector = String(args.waitSelector);
    if (selector.length > 500) throw new Error("waitSelector is too long.");
    command.push("--wait-selector", selector);
  }
  return { command, timeoutMs, maxOutputBytes };
}

export function parseFetchResult(result) {
  if (result.timedOut) throw Object.assign(new Error("Lightpanda execution timed out; no fallback was attempted."), { code: "LIGHTPANDA_TIMEOUT", retryable: true });
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    const detail = (result.stderr || result.stdout || "no diagnostic output").trim().slice(0, 1000);
    throw Object.assign(new Error(`Lightpanda returned an incompatible response: ${detail}`), { code: "LIGHTPANDA_INCOMPATIBLE" });
  }
  if (result.code !== 0 || payload.error) {
    const detail = payload.error || result.stderr || `exit ${result.code}`;
    throw Object.assign(new Error(`Lightpanda could not render this page (${detail}); select another browser explicitly.`), { code: "LIGHTPANDA_PAGE_FAILED" });
  }
  return payload;
}

export function extractPublicLinks(html, baseUrl, maxLinks = 50) {
  const links = [];
  const seen = new Set();
  const limit = boundedInteger(maxLinks, 50, 1, 100);
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    if (links.length >= limit) break;
    try {
      const resolved = new URL(decodeAttribute(match[1] ?? match[2] ?? match[3] ?? ""), baseUrl);
      const url = parsePublicHttpUrl(resolved.href);
      url.hash = "";
      const value = url.href;
      if (!seen.has(value)) {
        seen.add(value);
        links.push(value);
      }
    } catch {
      // Ignore malformed page-provided links.
    }
  }
  return links;
}

export async function performBrowse({ input, mode, config, args = {}, binary, execute, lookup }) {
  const normalizedMode = normalizeMode(mode);
  const url = await validatePublicUrl(input, lookup ? { lookup } : undefined);
  const specification = buildFetchArgs(url, normalizedMode, config, args);
  const result = await execute(binary, specification.command, {
    timeoutMs: specification.timeoutMs + 2_000,
    maxCaptureBytes: Math.min(2 * 1024 * 1024, specification.maxOutputBytes * 4 + 128 * 1024)
  });
  const payload = parseFetchResult(result);
  const finalUrl = new URL(payload.url || url.href);
  await validatePublicUrl(finalUrl.href, lookup ? { lookup } : undefined);

  if (normalizedMode === "extract-links") {
    const links = extractPublicLinks(payload.content, finalUrl, args.maxLinks);
    const bounded = boundUtf8(links.map((link, index) => `${index + 1}. ${link}`).join("\n"), specification.maxOutputBytes);
    return {
      text: bounded.text || "No public HTTP(S) links found.",
      json: { engine: "lightpanda", mode: normalizedMode, url: finalUrl.href, status: payload.http_status ?? null, links, truncated: bounded.truncated, bytes: bounded.bytes }
    };
  }

  const bounded = boundUtf8(payload.content || "", specification.maxOutputBytes);
  return {
    text: bounded.text,
    json: { engine: "lightpanda", mode: normalizedMode, url: finalUrl.href, status: payload.http_status ?? null, truncated: bounded.truncated, bytes: bounded.bytes }
  };
}
