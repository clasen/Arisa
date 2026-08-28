import path from "node:path";
import { readFile, readdir, readlink } from "node:fs/promises";

export async function readProcessRssMiB(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return Number((Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0) / 1024).toFixed(1));
  } catch {
    return 0;
  }
}

export async function readHostMemoryMiB() {
  const text = await readFile("/proc/meminfo", "utf8");
  const value = (name) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m"))?.[1] || 0) / 1024;
  return {
    available: Number(value("MemAvailable").toFixed(1)),
    swapFree: Number(value("SwapFree").toFixed(1)),
    swapTotal: Number(value("SwapTotal").toFixed(1))
  };
}

export async function lightpandaProcessIds() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const pids = [];
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    try {
      const executable = await readlink(`/proc/${entry.name}/exe`);
      if (path.basename(executable) === "lightpanda") pids.push(Number(entry.name));
    } catch {
      // The process may exit between directory and symlink reads.
    }
  }));
  return pids.sort((a, b) => a - b);
}
