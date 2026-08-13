import { spawn } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function resolveAllowedPath(target, roots) {
  if (typeof target !== "string" || !path.isAbsolute(target)) {
    const error = new Error("Slave filesystem paths must be absolute");
    error.code = "PATH_NOT_ALLOWED";
    throw error;
  }
  if (!Array.isArray(roots) || !roots.length) {
    const error = new Error("Slave policy has no allowed roots");
    error.code = "PATH_NOT_ALLOWED";
    throw error;
  }
  const [resolvedTarget, resolvedRoots] = await Promise.all([
    realpath(target),
    Promise.all(roots.map((root) => realpath(root)))
  ]);
  if (!resolvedRoots.some((root) => isWithin(root, resolvedTarget))) {
    const error = new Error(`Path is outside the Slave allowed roots: ${target}`);
    error.code = "PATH_NOT_ALLOWED";
    throw error;
  }
  return resolvedTarget;
}

export async function listSlavePath({ target, roots, maxEntries }) {
  const allowed = await resolveAllowedPath(target, roots);
  const metadata = await stat(allowed);
  if (!metadata.isDirectory()) throw new Error(`Path is not a directory: ${target}`);
  requirePositiveInteger(maxEntries, "maxEntries");
  const entries = await readdir(allowed, { withFileTypes: true });
  if (entries.length > maxEntries) {
    const error = new Error(`Directory contains ${entries.length} entries; limit is ${maxEntries}`);
    error.code = "OUTPUT_LIMIT_EXCEEDED";
    throw error;
  }
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
  }));
}

export async function readSlaveFile({ target, roots, maxBytes }) {
  const allowed = await resolveAllowedPath(target, roots);
  const metadata = await stat(allowed);
  if (!metadata.isFile()) throw new Error(`Path is not a file: ${target}`);
  requirePositiveInteger(maxBytes, "maxBytes");
  if (metadata.size > maxBytes) {
    const error = new Error(`File contains ${metadata.size} bytes; limit is ${maxBytes}`);
    error.code = "OUTPUT_LIMIT_EXCEEDED";
    throw error;
  }
  const handle = await open(allowed, "r");
  try {
    const content = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(content, 0, metadata.size, 0);
    return { path: allowed, bytes: bytesRead, content: content.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

function requireArgv(argv) {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
    throw new Error("process.exec argv must be an array of strings");
  }
  return argv;
}

function terminateProcessTree(child, platform = process.platform) {
  if (!child.pid) return;
  if (platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export class SlaveProcessExecutor {
  constructor({ roots, maxOutputBytes, maxTimeoutMs, environment = process.env, spawnProcess = spawn } = {}) {
    this.roots = roots;
    this.maxOutputBytes = requirePositiveInteger(maxOutputBytes, "maxOutputBytes");
    this.maxTimeoutMs = requirePositiveInteger(maxTimeoutMs, "maxTimeoutMs");
    this.environment = environment;
    this.spawnProcess = spawnProcess;
    this.active = new Map();
  }

  async execute({ jobId, executable, argv = [], cwd, timeoutMs }, { onChunk } = {}) {
    if (typeof jobId !== "string" || !jobId) throw new Error("jobId is required");
    if (this.active.has(jobId)) {
      const error = new Error(`Job is already running: ${jobId}`);
      error.code = "JOB_ALREADY_RUNNING";
      throw error;
    }
    if (typeof executable !== "string" || !executable.trim()) throw new Error("process.exec executable is required");
    const args = requireArgv(argv);
    const allowedCwd = await resolveAllowedPath(cwd, this.roots);
    const effectiveTimeoutMs = requirePositiveInteger(timeoutMs, "timeoutMs");
    if (effectiveTimeoutMs > this.maxTimeoutMs) {
      throw new Error(`process.exec timeout exceeds policy limit of ${this.maxTimeoutMs}ms`);
    }

    const child = this.spawnProcess(executable, args, {
      cwd: allowedCwd,
      env: this.environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const state = { child, cancelled: false, timedOut: false, outputBytes: 0, sequence: 0, chunks: [] };
    this.active.set(jobId, state);

    const consume = (stream, channel) => new Promise((resolve, reject) => {
      let chain = Promise.resolve();
      stream.on("data", (chunk) => {
        stream.pause();
        chain = chain.then(async () => {
          state.outputBytes += chunk.length;
          if (state.outputBytes > this.maxOutputBytes) {
            const error = new Error(`Job output exceeds policy limit of ${this.maxOutputBytes} bytes`);
            error.code = "OUTPUT_LIMIT_EXCEEDED";
            terminateProcessTree(child);
            throw error;
          }
          const record = { sequence: ++state.sequence, channel, data: chunk.toString("utf8") };
          state.chunks.push(record);
          await onChunk?.(record);
          stream.resume();
        }).catch(reject);
      });
      stream.once("end", () => chain.then(resolve, reject));
      stream.once("error", reject);
    });

    const timer = setTimeout(() => {
      state.timedOut = true;
      terminateProcessTree(child);
    }, effectiveTimeoutMs);
    timer.unref?.();

    try {
      const stdout = consume(child.stdout, "stdout");
      const stderr = consume(child.stderr, "stderr");
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      await Promise.all([stdout, stderr]);
      if (state.cancelled) return { status: "cancelled", ...exit, chunks: state.chunks };
      if (state.timedOut) return { status: "expired", ...exit, chunks: state.chunks };
      return { status: exit.code === 0 ? "completed" : "failed", ...exit, chunks: state.chunks };
    } finally {
      clearTimeout(timer);
      this.active.delete(jobId);
    }
  }

  cancel(jobId) {
    const state = this.active.get(jobId);
    if (!state) return false;
    state.cancelled = true;
    terminateProcessTree(state.child);
    return true;
  }
}
