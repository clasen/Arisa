import path from "node:path";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { piAuthFile, primeAuthFile } from "../../runtime/paths.js";

function isCredential(value) {
  return value && typeof value === "object" && (value.type === "api_key" || value.type === "oauth");
}

async function readAuthFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isCredential(value)));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function modifiedAt(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function syncPrimeAuth({ provider, apiKey, sourceFile = piAuthFile, targetFile = primeAuthFile } = {}) {
  const source = await readAuthFile(sourceFile);
  const target = await readAuthFile(targetFile);
  const sourceIsNewer = await modifiedAt(sourceFile) > await modifiedAt(targetFile);
  const merged = sourceIsNewer ? { ...target, ...source } : { ...source, ...target };
  if (provider && apiKey) {
    merged[provider] = { type: "api_key", key: apiKey };
  }

  await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  await writeFile(targetFile, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(targetFile, 0o600).catch(() => {});
  return { providers: Object.keys(merged), targetFile };
}

export async function backupPiAuthForPrime({ sourceFile = piAuthFile, targetFile = `${primeAuthFile}.pi-backup` } = {}) {
  await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  await copyFile(sourceFile, targetFile);
  await chmod(targetFile, 0o600).catch(() => {});
  return targetFile;
}
