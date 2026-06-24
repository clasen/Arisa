import net from "node:net";
import path from "node:path";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { arisaIpcSocketFile } from "../paths.js";

function writeResponse(socket, response) {
  socket.write(`${JSON.stringify(response)}\n`);
}

function isStaleSocketError(error) {
  return ["ENOENT", "ECONNREFUSED"].includes(error?.code);
}

function isNamedPipe(socketPath) {
  return typeof socketPath === "string" && /^\\\\[.?]\\pipe\\/i.test(socketPath);
}

async function hasLiveSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("connect", () => {
      client.end();
      resolve(true);
    });
    client.once("error", (error) => {
      if (isStaleSocketError(error)) {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

export function createIpcServer({ capabilities, socketPath = arisaIpcSocketFile, logger } = {}) {
  let server = null;

  async function handleLine(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeResponse(socket, { id: null, ok: false, error: "invalid JSON request" });
      return;
    }

    try {
      const result = await capabilities.dispatch(request);
      writeResponse(socket, { id: request.id ?? null, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.log?.("ipc", `request failed: ${message}`);
      writeResponse(socket, { id: request.id ?? null, ok: false, error: message });
    }
  }

  async function start() {
    if (server) return { socketPath };
    const namedPipe = isNamedPipe(socketPath);
    if (!namedPipe) {
      await mkdir(path.dirname(socketPath), { recursive: true });
    }

    if (await hasLiveSocket(socketPath)) {
      throw new Error(`Arisa IPC socket already in use: ${socketPath}`);
    }
    if (!namedPipe) {
      await unlink(socketPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }

    server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) handleLine(socket, line);
          newlineIndex = buffer.indexOf("\n");
        }
      });
      socket.on("error", (error) => {
        logger?.log?.("ipc", `client socket error: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    if (!namedPipe) {
      await chmod(socketPath, 0o600).catch(() => {});
    }
    logger?.log?.("ipc", `listening on ${socketPath}`);
    return { socketPath };
  }

  async function stop() {
    if (!server) return;
    const closingServer = server;
    server = null;
    await new Promise((resolve) => closingServer.close(resolve));
    if (!isNamedPipe(socketPath)) {
      await unlink(socketPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  return {
    start,
    stop,
    address: () => server?.address() || null,
    get socketPath() {
      return socketPath;
    }
  };
}
