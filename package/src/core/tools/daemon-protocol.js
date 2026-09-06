import path from "node:path";

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_EVENT_TYPES = Object.freeze(["accepted", "progress", "chunk", "completed", "failed"]);
export const DAEMON_CONTROL_FIELD = "__daemon";

const TERMINAL_EVENT_TYPES = new Set(["completed", "failed"]);

export function daemonJobPaths(paths, id) {
  return {
    request: path.join(paths.commandsDir, `${id}.request.json`),
    processing: path.join(paths.commandsDir, `${id}.processing.json`),
    result: path.join(paths.resultsDir || paths.commandsDir, `${id}.result.json`)
  };
}

export function daemonFrame(jobId, type, sequence, payload = {}) {
  return { version: DAEMON_PROTOCOL_VERSION, jobId, type, sequence, payload };
}

export function daemonTerminalResult(frame) {
  if (frame.type === "failed") {
    const error = new Error(frame.payload?.error || "Daemon job failed");
    if (frame.payload?.code) error.code = frame.payload.code;
    throw error;
  }
  return frame.payload?.output || {};
}

export function validateDaemonEvent(frame, { jobId, previousSequence = 0, terminalSeen = false } = {}) {
  if (!frame || frame.version !== DAEMON_PROTOCOL_VERSION || frame.jobId !== jobId) {
    throw new Error("Invalid daemon event identity or protocol version");
  }
  if (!DAEMON_EVENT_TYPES.includes(frame.type)) throw new Error(`Invalid daemon event type: ${frame.type}`);
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= previousSequence) {
    throw new Error(`Invalid daemon event sequence for ${jobId}: ${frame.sequence}`);
  }
  if (terminalSeen) throw new Error(`Daemon job ${jobId} emitted more than one terminal event`);
  return { sequence: frame.sequence, terminal: TERMINAL_EVENT_TYPES.has(frame.type) };
}

export async function writeDaemonSocketFrame(socket, frame, {
  maxFrameBytes = 1_048_576,
  streamBufferBytes = 1_048_576
} = {}) {
  if (socket.destroyed || !socket.writable) return false;
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxFrameBytes) {
    throw new Error(`Daemon IPC frame exceeds ${maxFrameBytes} bytes`);
  }
  if (socket.writableLength >= streamBufferBytes) {
    await waitForWritableSocket(socket);
    if (socket.destroyed || !socket.writable) return false;
  }
  if (socket.write(encoded)) return true;
  await waitForWritableSocket(socket);
  return !socket.destroyed;
}

function waitForWritableSocket(socket) {
  return new Promise((resolve) => {
    const finish = () => {
      socket.off("drain", finish);
      socket.off("close", finish);
      socket.off("error", finish);
      resolve();
    };
    socket.once("drain", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });
}
