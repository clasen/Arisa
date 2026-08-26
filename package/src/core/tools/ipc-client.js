import crypto from "node:crypto";
import net from "node:net";
import { arisaIpcSocketFile } from "../../platform/paths.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function requestIpc({ socketPath, request, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.end();
      fn(value);
    }

    const timeout = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error("Arisa IPC request timed out"));
    }, timeoutMs);
    timeout.unref?.();

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      try {
        const response = JSON.parse(line);
        if (!response.ok) {
          finish(reject, new Error(response.error || "Arisa IPC request failed"));
          return;
        }
        finish(resolve, response.result);
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.once("error", (error) => {
      finish(reject, error);
    });
    socket.once("close", () => {
      finish(reject, new Error("Arisa IPC connection closed before response"));
    });
  });
}

export function createArisaClient({
  toolName,
  chatId = null,
  socketPath = process.env.ARISA_IPC_SOCKET || arisaIpcSocketFile
} = {}) {
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new Error("toolName is required");
  }

  const call = (method, params = {}, options = {}) => requestIpc({
    socketPath,
    timeoutMs: options.timeoutMs,
    request: {
      id: crypto.randomUUID(),
      method,
      toolName,
      chatId,
      params
    }
  });

  return {
    artifacts: {
      createText: (params) => call("artifacts.createText", params),
      listRecent: (params) => call("artifacts.listRecent", params),
      get: (params) => call("artifacts.get", params),
      deliver: (params) => call("artifacts.deliver", params, { timeoutMs: 120_000 })
    },
    tasks: {
      add: (params) => call("tasks.add", params),
      list: (params) => call("tasks.list", params),
      cancel: (params) => call("tasks.cancel", params),
      cancelAll: () => call("tasks.cancelAll")
    },
    agent: {
      enqueueEvent: (params) => call("agent.enqueueEvent", params)
    },
    tools: {
      list: () => call("tools.list"),
      help: (params) => call("tools.help", params),
      skills: (params) => call("tools.skills", params),
      setConfig: (params) => call("tools.setConfig", params),
      setResourceNote: (params) => call("tools.setResourceNote", params),
      getResourceNote: (params) => call("tools.getResourceNote", params),
      installOfficial: (params, options) => call("tools.installOfficial", params, options),
      run: (params, options) => call("tools.run", params, options)
    },
    paths: {
      getChatToolStateDir: () => call("paths.getChatToolStateDir"),
      getToolStateDir: () => call("paths.getToolStateDir"),
      getChatToolTmpDir: () => call("paths.getChatToolTmpDir"),
      getToolTmpDir: () => call("paths.getToolTmpDir"),
      getChatArtifactsDir: () => call("paths.getChatArtifactsDir")
    }
  };
}
