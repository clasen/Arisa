#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import defaults from "./config.js";
import { claimDelivery, deliveryClaimed } from "./delivery-claims.js";
import { cancelPendingGenerationWatches, claimTerminalEvent } from "./generation-watch-close.js";
import { generationWatchTasks } from "./generation-watch-plan.js";
import { startGeneration } from "./generation-request.js";
import { callMagnific, findAll, findFirst, findUpload } from "./magnific-api.js";
import { extension, mediaKind, outputMime } from "./media-output.js";
import { transfer } from "./network.js";
import { pruneState, readState, writeState } from "./state-store.js";

const TOOL_NAME = "magnific-mcp";
const MODES = new Set(["creative", "ultra-sublime", "ultra-photo", "ultra-denoiser", "ultra"]);
const SCALES = new Set(["2x", "4x", "8x", "16x"]);
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);

function usage() {
  return `magnific-mcp

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions:
  balance          Read plan and credit balance without charging credits
  modes              Read available upscale modes and parameters
  generate           Generate 1–8 images and monitor them reactively. An attached image artifact is used as a reference. args: prompt, mode?, aspectRatio?, count?
  watch-generation   Internal interruption-safe generation checker
  collect-generation Download one ready job image. args: jobId, index
  download           Download one completed Magnific image, audio, or video creation as an artifact. args: creationIdentifier
  prepare-upscale    Upload an image artifact and prepare its upscale parameters
  upscale            Run one prepared upscale directly. args: preparationId

prepare-upscale args:
  mode=creative|ultra-sublime|ultra-photo|ultra-denoiser|ultra
  scale=2x|4x|8x|16x
  Optional mode parameters: prompt, presets, optimised, engine, precisionPreset,
  creativity, resemblance, hdr, fractality, sharpness, grain, ultraDetail
`;
}

function clean(value) { return String(value ?? "").trim(); }
function integer(value, min, max, name) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function upscaleArguments(args, creationIdentifier) {
  const mode = clean(args.mode || "creative");
  const scale = clean(args.scale || "2x");
  if (!MODES.has(mode)) throw new Error(`Unsupported upscale mode: ${mode}`);
  if (!SCALES.has(scale)) throw new Error(`Unsupported upscale scale: ${scale}`);
  if (mode !== "creative" && mode !== "ultra-sublime" && scale !== "2x") throw new Error(`${mode} supports only 2x`);
  const value = { creationIdentifier, mode, scale };
  for (const key of ["prompt", "presets", "optimised", "engine", "precisionPreset"]) if (clean(args[key])) value[key] = clean(args[key]);
  for (const [key, range] of Object.entries({ creativity: [-10, 10], resemblance: [-10, 10], hdr: [-10, 10], fractality: [-10, 10], sharpness: [0, 100], grain: [0, 100], ultraDetail: [0, 100] })) {
    const parsed = integer(args[key], range[0], range[1], key);
    if (parsed !== undefined) value[key] = parsed;
  }
  return value;
}

function generationStatuses(result) {
  return findAll(result, "status").map((value) => clean(value).toLowerCase());
}

async function uploadArtifact({ arisa, profile, artifact, maxBytes }) {
  if (!artifact?.path) throw new Error("An image artifact is required");
  const mimeType = clean(artifact.mimeType).split(";", 1)[0];
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) throw new Error("Magnific accepts JPEG, PNG, or WebP image artifacts");
  const info = await stat(artifact.path);
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error(`Image must be between 1 and ${maxBytes} bytes`);
  const requested = await callMagnific(arisa, profile, "creations_request_upload", { mimeType });
  const upload = findUpload(requested);
  if (!upload) throw new Error("Magnific did not return a usable upload target");
  const bytes = await readFile(artifact.path);
  await transfer(upload.url, {
    method: upload.method || "PUT",
    headers: { "Content-Type": mimeType, ...(upload.headers || {}) },
    body: bytes
  });
  const finalized = await callMagnific(arisa, profile, "creations_finalize_upload", { path: upload.path, visible: false });
  const creationIdentifier = clean(findFirst(finalized, ["creationIdentifier", "identifier"]));
  if (!creationIdentifier) throw new Error("Magnific upload finalized without a creation identifier");
  return creationIdentifier;
}

async function downloadCreation({ arisa, profile, identifier, paths, chatId, tool = "magnific-mcp" }) {
  const creation = await callMagnific(arisa, profile, "creations_get", { creationIdentifier: identifier });
  const url = findFirst(creation, ["url", "originalUrl"]);
  if (!url) throw new Error("Completed Magnific creation has no download URL");
  await callMagnific(arisa, profile, "creations_register_download", { identifiers: [identifier], tool });
  const response = await transfer(url, {}, 120000);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = outputMime(creation, response.headers.get("content-type") || "application/octet-stream");
  const tmpDir = paths.getChatToolTmpDir(chatId, TOOL_NAME);
  await mkdir(tmpDir, { recursive: true });
  const fileName = `magnific-${identifier}${extension(mimeType)}`;
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, bytes, { mode: 0o600 });
  const kind = mediaKind(mimeType);
  return {
    filePath,
    fileName,
    mimeType,
    kind,
    ...(kind === "audio" ? { delivery: { method: "audio" } } : {})
  };
}

async function waitForCreation(arisa, profile, identifier, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waited = await callMagnific(arisa, profile, "creations_wait", { identifiers: [identifier], timeoutSeconds: 25 }, 60000);
    const status = clean(findFirst(waited, ["status", "state"])).toLowerCase();
    const url = findFirst(waited, ["url", "originalUrl"]);
    if (url || ["completed", "complete", "succeeded", "success", "failed", "error", "cancelled"].includes(status)) return waited;
  }
  throw new Error("Magnific upscale did not finish within the configured timeout");
}

async function mainRun(request) {
  if (!process.env.ARISA_PACKAGE_DIR) throw new Error("ARISA_PACKAGE_DIR is required");
  const [{ createArisaClient }, { loadToolConfig }, { toolError, toolOk }, paths] = await Promise.all([
    importCore("core/tools/ipc-client.js"),
    importCore("core/tools/tool-config.js"),
    importCore("core/tools/tool-result.js"),
    importCore("runtime/paths.js")
  ]);
  const chatId = clean(request.chatId);
  if (!chatId) return toolError("chatId is required");
  const args = request.args || {};
  const action = clean(args.action || "balance").toLowerCase();
  const config = await loadToolConfig(TOOL_NAME, defaults, chatId);
  const profile = clean(config.MCP_PROFILE || defaults.MCP_PROFILE);
  const arisa = createArisaClient({ toolName: TOOL_NAME, chatId });

  if (action === "balance") {
    const balance = await callMagnific(arisa, profile, "account_balance");
    return toolOk({ text: "Magnific balance read without consuming credits.", json: balance, mimeType: "application/json" });
  }
  if (action === "modes") {
    const modes = await callMagnific(arisa, profile, "images_upscale_modes_list");
    return toolOk({ text: "Magnific upscale modes loaded without consuming credits.", json: modes, mimeType: "application/json" });
  }
  if (action === "download") {
    const identifier = clean(args.creationIdentifier);
    if (!identifier) return toolError("creationIdentifier is required");
    const output = await downloadCreation({ arisa, profile, identifier, paths, chatId });
    return toolOk({ ...output, text: "Magnific creation downloaded." });
  }

  const stateDir = paths.getChatToolStateDir(chatId, TOOL_NAME);
  const state = pruneState(await readState(stateDir));

  if (action === "generate") {
    const { generationArgs, reference, started } = await startGeneration({
      args,
      artifact: request.artifact,
      uploadReference: (artifact) => uploadArtifact({
        arisa,
        profile,
        artifact,
        maxBytes: Number(config.MAX_UPLOAD_BYTES || defaults.MAX_UPLOAD_BYTES)
      }),
      generate: (value) => callMagnific(arisa, profile, "images_generate", value)
    });
    const identifiers = [...new Set(findAll(started, "identifier").map(clean).filter(Boolean))];
    if (!identifiers.length) throw new Error("Magnific generation returned no creation identifiers");
    const jobId = randomUUID();
    const watchToken = randomUUID();
    const createdAt = new Date().toISOString();
    state.jobs[jobId] = {
      jobId,
      watchToken,
      identifiers,
      generationArgs,
      reference,
      status: "queued",
      deliveryAttempts: {},
      createdAt,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      lastNotificationAt: null
    };
    await writeState(stateDir, state);
    return toolOk({
      text: `Magnific queued ${identifiers.length} image(s)${reference ? " using the attached reference" : ""}. Delivery will continue automatically if this turn is interrupted.`,
      json: { jobId, count: identifiers.length, referenceAttached: Boolean(reference), reactiveDelivery: true },
      mimeType: "application/json"
    }, {
      status: "scheduled",
      asyncTasks: generationWatchTasks(jobId, watchToken)
    });
  }

  if (action === "watch-generation") {
    const jobId = clean(args.jobId);
    const job = state.jobs[jobId];
    if (!job || clean(args.watchToken) !== job.watchToken) return toolOk({ json: { skipped: "stale-job" }, mimeType: "application/json" });
    const undelivered = [];
    for (let index = 0; index < job.identifiers.length; index += 1) {
      if (!job.deliveryAttempts[index] && !(await deliveryClaimed(stateDir, jobId, index))) undelivered.push(index);
    }
    if (!undelivered.length) return toolOk({ json: { jobId, status: "delivery-attempted" }, mimeType: "application/json" });
    if (job.status !== "ready" && job.status !== "failed") {
      const snapshot = await callMagnific(arisa, profile, "creations_wait", { identifiers: job.identifiers, timeoutSeconds: 0 }, 30000);
      const statuses = generationStatuses(snapshot);
      const terminal = Boolean(findFirst(snapshot, ["allTerminal"])) || (statuses.length >= job.identifiers.length && statuses.every((status) => ["completed", "failed", "error", "cancelled"].includes(status)));
      if (!terminal) return toolOk({ json: { jobId, status: "pending" }, mimeType: "application/json" });
      job.status = statuses.some((status) => status !== "completed") ? "failed" : "ready";
      job.readyAt = new Date().toISOString();
    }
    const claimed = await claimTerminalEvent(stateDir, jobId, job.status);
    if (!claimed) return toolOk({ json: { jobId, status: job.status, skipped: "terminal-event-claimed" }, mimeType: "application/json" });
    job.lastNotificationAt = new Date().toISOString();
    await writeState(stateDir, state);
    let cancelledWatches = 0;
    let watchCancellationFailed = false;
    try {
      cancelledWatches = await cancelPendingGenerationWatches(arisa, jobId, job.watchToken);
    } catch {
      watchCancellationFailed = true;
    }
    const prompt = job.status === "failed"
      ? `Magnific generation job ${jobId} reached a failed terminal state. Tell the user briefly. Do not regenerate automatically.`
      : `Magnific generation job ${jobId} is ready. Deliver every undelivered image now by running magnific-mcp action collect-generation with jobId ${jobId} and each index in [${undelivered.join(",")}], using deliver=true. Do not regenerate. Each collect is fail-closed against uncertain duplicate delivery. After delivery, tell the user briefly that the images are ready.`;
    return toolOk({ json: { jobId, status: job.status, undelivered, cancelledWatches, watchCancellationFailed }, mimeType: "application/json" }, {
      asyncTask: { kind: "agent_event", payload: { prompt } }
    });
  }

  if (action === "collect-generation") {
    const jobId = clean(args.jobId);
    const job = state.jobs[jobId];
    if (!job) return toolError("Unknown or expired generation job");
    if (job.status !== "ready") return toolError("Generation job is not ready");
    const index = integer(args.index, 0, job.identifiers.length - 1, "index");
    if (job.deliveryAttempts[index] || await deliveryClaimed(stateDir, jobId, index)) return toolError("Delivery was already attempted for this image; automatic retry is blocked");
    await claimDelivery(stateDir, jobId, index, job.identifiers[index]);
    const output = await downloadCreation({ arisa, profile, identifier: job.identifiers[index], paths, chatId, tool: "images_generate" });
    job.deliveryAttempts[index] = new Date().toISOString();
    if (Object.keys(job.deliveryAttempts).length >= job.identifiers.length) job.status = "delivery-attempted";
    await writeState(stateDir, state);
    return toolOk({ ...output, text: `Magnific generation image ${index + 1} of ${job.identifiers.length} ready.` });
  }

  if (action === "prepare-upscale") {
    const creationIdentifier = await uploadArtifact({
      arisa,
      profile,
      artifact: request.artifact,
      maxBytes: Number(config.MAX_UPLOAD_BYTES || defaults.MAX_UPLOAD_BYTES)
    });
    const upscaleArgs = upscaleArguments(args, creationIdentifier);
    const preparationId = randomUUID();
    const expiresAt = new Date(Date.now() + Number(config.PREPARATION_TTL_MS || defaults.PREPARATION_TTL_MS)).toISOString();
    state.preparations[preparationId] = { creationIdentifier, upscaleArgs, createdAt: new Date().toISOString(), expiresAt };
    await writeState(stateDir, state);
    return toolOk({
      text: `Magnific upscale prepared with mode ${upscaleArgs.mode} at ${upscaleArgs.scale}.`,
      json: { preparationId, expiresAt, mode: upscaleArgs.mode, scale: upscaleArgs.scale },
      mimeType: "application/json"
    });
  }

  if (action === "upscale") {
    const preparationId = clean(args.preparationId);
    const preparation = state.preparations[preparationId];
    if (!preparation) return toolError("Unknown, expired, or already used preparationId");
    preparation.usedAt = new Date().toISOString();
    await writeState(stateDir, state);
    const started = await callMagnific(arisa, profile, "images_upscale", preparation.upscaleArgs);
    const identifier = clean(findFirst(started, ["creationIdentifier", "identifier"]));
    if (!identifier) throw new Error("Magnific upscale started without a creation identifier");
    await waitForCreation(arisa, profile, identifier, Number(config.RESULT_TIMEOUT_MS || defaults.RESULT_TIMEOUT_MS));
    const output = await downloadCreation({ arisa, profile, identifier, paths, chatId, tool: "images_upscale" });
    return toolOk({ ...output, text: "Magnific upscale completed." });
  }

  return toolError(`Unsupported action: ${action}`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.length <= 2) return process.stdout.write(usage());
  const index = process.argv.indexOf("--request-file");
  if (process.argv[2] !== "run" || index < 0 || !process.argv[index + 1]) throw new Error("Expected run --request-file <json>");
  const request = JSON.parse(await readFile(process.argv[index + 1], "utf8"));
  process.stdout.write(`${JSON.stringify(await mainRun(request))}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, status: "failed", error: error?.message || String(error) })}\n`);
  process.exitCode = 1;
});
