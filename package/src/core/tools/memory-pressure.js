import os from "node:os";
import { readFile } from "node:fs/promises";

function linuxMemoryValues(text) {
  const values = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  return values;
}

export async function readMemoryPressure({
  platform = process.platform,
  readMemInfo = () => readFile("/proc/meminfo", "utf8"),
  freeMemory = () => os.freemem(),
  totalMemory = () => os.totalmem(),
  processMemory = () => process.memoryUsage()
} = {}) {
  let availableBytes = Number(freeMemory()) || 0;
  let totalBytes = Number(totalMemory()) || 0;
  let swapTotalBytes = 0;
  let swapFreeBytes = 0;
  if (platform === "linux") {
    try {
      const values = linuxMemoryValues(await readMemInfo());
      availableBytes = values.get("MemAvailable") || availableBytes;
      totalBytes = values.get("MemTotal") || totalBytes;
      swapTotalBytes = values.get("SwapTotal") || 0;
      swapFreeBytes = values.get("SwapFree") || 0;
    } catch {}
  }
  const swapUsedPercent = swapTotalBytes > 0
    ? ((swapTotalBytes - swapFreeBytes) / swapTotalBytes) * 100
    : 0;
  return {
    availableBytes,
    totalBytes,
    swapTotalBytes,
    swapFreeBytes,
    swapUsedPercent,
    workerRssBytes: Number(processMemory()?.rss) || 0
  };
}

export function memoryPressureReason(snapshot, policy) {
  const mebibyte = 1024 * 1024;
  const availableMb = snapshot.availableBytes / mebibyte;
  const workerRssMb = snapshot.workerRssBytes / mebibyte;
  if (availableMb < policy.minAvailableMemoryMb) {
    return `available memory ${Math.floor(availableMb)} MiB is below the ${policy.minAvailableMemoryMb} MiB reserve`;
  }
  if (workerRssMb > policy.maxWorkerRssMb) {
    return `worker RSS ${Math.ceil(workerRssMb)} MiB exceeds the ${policy.maxWorkerRssMb} MiB limit`;
  }
  if (snapshot.swapTotalBytes > 0 && snapshot.swapUsedPercent > policy.maxSwapUsedPercent) {
    return `swap use ${Math.ceil(snapshot.swapUsedPercent)}% exceeds the ${policy.maxSwapUsedPercent}% limit`;
  }
  return "";
}
