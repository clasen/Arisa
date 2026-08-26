import crypto from "node:crypto";
import net from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { daemonPaths, readJson, writeJson } from "./daemon-processes.js";
import { loadDaemonPolicy } from "./daemon-policy.js";
import {
  DAEMON_CONTROL_FIELD,
  DAEMON_PROTOCOL_VERSION,
  daemonJobPaths,
  daemonTerminalResult,
  validateDaemonEvent
} from "./daemon-protocol.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCapability(paths) {
  const token = (await readFile(paths.capabilityFile, "utf8")).trim();
  if (!token) throw new Error(`Invalid daemon capability for ${paths.toolName}`);
  return token;
}

export async function connectDaemon(paths, request, { timeoutMs, onEvent, maxFrameBytes }) {
  const startedAt = Date.now();
  const token = await readCapability(paths);
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(paths.socketFile);
        let buffer = "";
        let sequence = 0;
        let terminalSeen = false;
        let settled = false;
        let submitted = false;
        let timeoutTriggered = false;
        let observerChain = Promise.resolve();
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
        let cancelTimer;
        const timeoutError = Object.assign(
          new Error(`${paths.toolName} daemon job timed out after ${timeoutMs}ms`),
          { code: "DAEMON_JOB_TIMEOUT" }
        );
        const timer = setTimeout(() => {
          timeoutTriggered = true;
          if (submitted && !socket.destroyed && socket.writable) {
            const frame = `${JSON.stringify({
              version: DAEMON_PROTOCOL_VERSION,
              type: "cancel",
              jobId: request.jobId,
              capabilityToken: token
            })}\n`;
            socket.end(frame, () => finish(reject, timeoutError));
            cancelTimer = setTimeout(() => finish(reject, timeoutError), 50);
            cancelTimer.unref?.();
            return;
          }
          finish(reject, timeoutError);
        }, remainingMs);
        timer.unref?.();

        function finish(fn, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(cancelTimer);
          socket.destroy();
          fn(value);
        }

        socket.setEncoding("utf8");
        socket.once("connect", () => {
          if (timeoutTriggered) return;
          submitted = true;
          socket.write(`${JSON.stringify({
            version: DAEMON_PROTOCOL_VERSION,
            type: "submit",
            jobId: request.jobId,
            capabilityToken: token
          })}\n`);
        });
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes && !buffer.includes("\n")) {
            finish(reject, new Error(`Daemon IPC frame exceeds ${maxFrameBytes} bytes`));
            return;
          }
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (!line) continue;
            let frame;
            try {
              frame = JSON.parse(line);
              const validated = validateDaemonEvent(frame, {
                jobId: request.jobId,
                previousSequence: sequence,
                terminalSeen
              });
              sequence = validated.sequence;
              terminalSeen = validated.terminal;
            } catch (error) {
              finish(reject, error);
              return;
            }
            observerChain = observerChain.then(() => onEvent?.(frame));
            if (terminalSeen) {
              observerChain.then(() => {
                if (timeoutTriggered) {
                  finish(reject, timeoutError);
                  return;
                }
                try {
                  finish(resolve, daemonTerminalResult(frame));
                } catch (error) {
                  finish(reject, error);
                }
              }, (error) => finish(reject, timeoutTriggered ? timeoutError : error));
            }
          }
        });
        socket.once("error", (error) => finish(reject, error));
        socket.once("close", () => {
          if (!settled) finish(reject, timeoutTriggered
            ? timeoutError
            : new Error("Daemon IPC connection closed before terminal result"));
        });
      });
    } catch (error) {
      lastError = error;
      if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
      await sleep(Math.min(25, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    }
  }
  const error = new Error(`${paths.toolName} daemon IPC was unavailable after ${timeoutMs}ms`);
  error.code = lastError?.code || "DAEMON_IPC_UNAVAILABLE";
  throw error;
}

export async function enqueueDaemonJob(paths, payload, {
  control = false,
  timeoutMs,
  onEvent,
  jobId,
  maxFrameBytes
} = {}) {
  await mkdir(paths.commandsDir, { recursive: true });
  const id = jobId || `${control ? "control" : "job"}-${crypto.randomUUID()}`;
  const files = daemonJobPaths(paths, id);
  const existingResult = await readJson(files.result, null);
  if (existingResult?.terminal) {
    await onEvent?.(existingResult.terminal);
    return daemonTerminalResult(existingResult.terminal);
  }
  const existingRequest = await readJson(files.request, null);
  const existingAccepted = await readJson(files.processing, null);
  if (!existingRequest && !existingAccepted) {
    await writeJson(files.request, {
      id,
      status: "queued",
      queuedAt: new Date().toISOString(),
      payload
    });
  }
  return connectDaemon(paths, { jobId: id }, { timeoutMs, onEvent, maxFrameBytes });
}

export async function submitDaemonControl(record, operation, { timeoutMs, onEvent } = {}) {
  const paths = daemonPaths({ toolName: record.toolName, scope: record.scope });
  const policy = await loadDaemonPolicy();
  return enqueueDaemonJob(paths, { [DAEMON_CONTROL_FIELD]: { operation } }, {
    control: true,
    timeoutMs: timeoutMs ?? policy.healthTimeoutMs,
    onEvent,
    maxFrameBytes: policy.ipcFrameBytes || 1_048_576
  });
}
