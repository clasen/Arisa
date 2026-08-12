import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import defaults from "./config.js";

const toolName = "x-reader";
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolNeedsConfig, toolOk } = await importCore("core/tools/tool-result.js");
const { getToolConfigPath, getChatToolConfigPath } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`x-reader

Usage:
  node index.js --help
  node index.js run --request-file <json>

Reads recent public posts from X/Twitter through the official X API. It does not bypass X login, anti-bot checks, or rate limits.

Expected input:
  {
    "text": "exampleuser" | "https://x.com/exampleuser",
    "args": {
      "username": "exampleuser",
      "maxResults": 5,
      "excludeReplies": true,
      "excludeRetweets": true,
      "raw": false
    }
  }

Config:
  X_BEARER_TOKEN  Official X API Bearer Token
  MAX_RESULTS     Default result count
`);
}

function usernameFrom(input = "", args = {}) {
  const direct = String(args.username || "").trim();
  if (direct) return direct.replace(/^@/, "");

  const text = String(input || "").trim();
  const urlMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
  if (urlMatch) return urlMatch[1];

  const handleMatch = text.match(/@?([A-Za-z0-9_]{1,15})/);
  return handleMatch ? handleMatch[1] : "";
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolArg(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no)$/i.test(String(value));
}

async function xFetch(pathname, token, params = {}) {
  const url = new URL(`https://api.twitter.com/2/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "user-agent": "arisa-x-reader/1.0"
    }
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }

  if (!response.ok) {
    const detail = payload?.detail || payload?.title || payload?.errors?.[0]?.message || text || `X API request failed with status ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

async function lookupUser(username, token) {
  return xFetch(`users/by/username/${encodeURIComponent(username)}`, token, {
    "user.fields": "description,username,name,verified,public_metrics"
  });
}

async function fetchTweets(userId, token, { maxResults, excludeReplies, excludeRetweets }) {
  const exclude = [excludeReplies ? "replies" : "", excludeRetweets ? "retweets" : ""].filter(Boolean).join(",");
  return xFetch(`users/${encodeURIComponent(userId)}/tweets`, token, {
    max_results: Math.min(Math.max(maxResults, 5), 100),
    exclude,
    "tweet.fields": "created_at,public_metrics,lang,source,conversation_id,referenced_tweets",
    expansions: "attachments.media_keys,referenced_tweets.id",
    "media.fields": "url,preview_image_url,type,alt_text"
  });
}

function formatTweet(tweet, index) {
  const metrics = tweet.public_metrics || {};
  const stats = [
    metrics.like_count != null ? `${metrics.like_count} likes` : null,
    metrics.retweet_count != null ? `${metrics.retweet_count} reposts` : null,
    metrics.reply_count != null ? `${metrics.reply_count} replies` : null
  ].filter(Boolean).join(" · ");
  return [
    `${index + 1}. ${tweet.created_at || "unknown date"}`,
    tweet.text || "",
    stats ? `   ${stats}` : null,
    `   https://x.com/i/web/status/${tweet.id}`
  ].filter(Boolean).join("\n");
}

function formatResult(username, userPayload, tweetsPayload) {
  const user = userPayload.data;
  const tweets = tweetsPayload.data || [];
  if (!tweets.length) return `@${username}: no recent public posts returned by the X API.`;

  return [
    `@${user.username} (${user.name}) latest public post${tweets.length === 1 ? "" : "s"}:`,
    "",
    ...tweets.map(formatTweet)
  ].join("\n\n");
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const config = await loadToolConfig(toolName, defaults, request.chatId ?? null);
  if (!config.X_BEARER_TOKEN) {
    console.log(JSON.stringify(toolNeedsConfig({
      tool: toolName,
      missingConfig: ["X_BEARER_TOKEN"],
      configPath: request.chatId != null ? getChatToolConfigPath(request.chatId, toolName) : getToolConfigPath(toolName),
      message: "I need an X API Bearer Token to read posts through the official X API."
    })));
    return;
  }

  const args = request.args || {};
  const rawInput = args.username || request.text || request.artifact?.text || "";
  const username = usernameFrom(rawInput, args);
  if (!username) {
    console.log(JSON.stringify(toolError("username, text handle, or X profile URL is required")));
    return;
  }

  try {
    const maxResults = intArg(args.maxResults, intArg(config.MAX_RESULTS, 5));
    const excludeReplies = boolArg(args.excludeReplies, true);
    const excludeRetweets = boolArg(args.excludeRetweets, true);
    const userPayload = await lookupUser(username, config.X_BEARER_TOKEN);
    const user = userPayload.data;
    if (!user?.id) throw new Error(`X user not found: ${username}`);
    const tweetsPayload = await fetchTweets(user.id, config.X_BEARER_TOKEN, { maxResults, excludeReplies, excludeRetweets });

    if (boolArg(args.raw, false)) {
      console.log(JSON.stringify(toolOk({
        text: JSON.stringify({ user: userPayload, tweets: tweetsPayload }, null, 2),
        mimeType: "application/json"
      })));
      return;
    }

    console.log(JSON.stringify(toolOk({ text: formatResult(username, userPayload, tweetsPayload) })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") {
  printHelp();
} else if (args[0] === "run") {
  const fileIndex = args.indexOf("--request-file");
  await run(args[fileIndex + 1]);
} else {
  printHelp();
}
