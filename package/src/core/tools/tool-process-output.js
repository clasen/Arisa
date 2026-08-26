import { DAEMON_EVENT_TYPES, DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";

export function createToolOutputParser(name, {
  onEvent,
  maxFrameBytes = 1_048_576,
  maxOutputBytes = maxFrameBytes
} = {}) {
  let buffer = "";
  let mode = "unknown";
  let rawOutput = "";
  let rawOutputBytes = 0;
  let terminalResult = null;
  let activeJobId = null;
  let sequence = 0;
  let terminalSeen = false;

  async function parseEvent(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Invalid NDJSON from ${name}`);
    }
    if (event?.version !== DAEMON_PROTOCOL_VERSION || !DAEMON_EVENT_TYPES.includes(event?.type)) {
      throw new Error(`Invalid versioned tool event from ${name}`);
    }
    if (typeof event.jobId !== "string" || !event.jobId) throw new Error(`Tool event from ${name} is missing jobId`);
    if (activeJobId == null) activeJobId = event.jobId;
    if (event.jobId !== activeJobId) throw new Error(`Tool ${name} multiplexed an unexpected jobId`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== sequence + 1) {
      throw new Error(`Invalid tool event sequence from ${name}: ${event.sequence}`);
    }
    if (terminalSeen) throw new Error(`Tool ${name} emitted more than one terminal event`);
    sequence = event.sequence;
    terminalSeen = event.type === "completed" || event.type === "failed";
    await onEvent?.(event);
    if (terminalSeen) {
      terminalResult = event.type === "completed"
        ? event.payload?.result ?? event.payload?.output ?? event.payload
        : { ok: false, error: event.payload?.error || `Tool failed: ${name}`, ...(event.payload?.code ? { code: event.payload.code } : {}) };
    }
  }

  async function consumeLine(line) {
    if (Buffer.byteLength(line, "utf8") > maxFrameBytes) throw new Error(`Tool event from ${name} exceeds ${maxFrameBytes} bytes`);
    if (mode === "unknown") {
      let candidate;
      try {
        candidate = JSON.parse(line);
      } catch {
        mode = "legacy";
        return;
      }
      if (candidate?.version === DAEMON_PROTOCOL_VERSION && DAEMON_EVENT_TYPES.includes(candidate?.type)) {
        mode = "ndjson";
        rawOutput = "";
        return parseEvent(line);
      }
      mode = "legacy";
      return;
    }
    if (mode === "legacy") return;
    return parseEvent(line);
  }

  return {
    async push(chunk) {
      const text = chunk.toString("utf8");
      if (mode !== "ndjson") {
        rawOutputBytes += Buffer.byteLength(text, "utf8");
        if (rawOutputBytes > maxOutputBytes) {
          const error = new Error(`Tool output from ${name} exceeds ${maxOutputBytes} bytes`);
          error.code = "TOOL_OUTPUT_LIMIT";
          throw error;
        }
        rawOutput += text;
      }
      if (mode === "legacy") return;
      buffer += text;
      if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes && !buffer.includes("\n")) {
        throw new Error(`Tool event from ${name} exceeds ${maxFrameBytes} bytes`);
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) await consumeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    async finish() {
      const tail = buffer.trim();
      buffer = "";
      if (tail) await consumeLine(tail);
      if (mode !== "ndjson") return { mode: "legacy", output: rawOutput };
      if (!terminalSeen) throw new Error(`Tool ${name} ended without a terminal event`);
      return { mode: "ndjson", result: terminalResult };
    }
  };
}
