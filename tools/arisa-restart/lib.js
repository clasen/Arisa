import { constants, readFileSync } from "node:fs";
import { access, mkdir, open, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const BOM = "\uFEFF";

export function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function isTrue(value) {
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    try {
      const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParenthesis = statLine.lastIndexOf(")");
      if (closingParenthesis >= 0 && statLine.slice(closingParenthesis + 2, closingParenthesis + 3) === "Z") return false;
    } catch {}
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8Json(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

export async function writeUtf8Json(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${BOM}${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function initializeUtf8Log(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, BOM, { encoding: "utf8", flag: "a" });
}

export async function acquireLock(lockPath, value) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(`${BOM}${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function retireLock(lockPath) {
  const retiredPath = `${lockPath}.${process.pid}.${Date.now()}.retired`;
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await rm(retiredPath, { force: true });
  return true;
}

export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });
}

export async function waitFor(predicate, { timeoutMs, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function readPidFile(pidFile) {
  try {
    const raw = await readFile(pidFile, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function readServiceIdentity(pid, entryFile) {
  if (!isProcessAlive(pid)) throw new Error(`PID ${pid} is not alive`);
  const commandFile = `/proc/${pid}/cmdline`;
  const statFile = `/proc/${pid}/stat`;
  await access(commandFile, constants.R_OK);
  const argv = (await readFile(commandFile)).toString("utf8").split("\0").filter(Boolean);
  const expectedEntry = path.resolve(entryFile);
  if (path.resolve(argv[1] || "") !== expectedEntry || !argv.includes("--service-runner")) {
    throw new Error(`PID ${pid} is not the expected Arisa service runner`);
  }
  const statLine = await readFile(statFile, "utf8");
  const closingParenthesis = statLine.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error(`PID ${pid} has an unreadable process identity`);
  const statFields = statLine.slice(closingParenthesis + 2).trim().split(/\s+/);
  if (statFields[0] === "Z") throw new Error(`PID ${pid} is a zombie`);
  const startTime = statFields[19];
  if (!startTime) throw new Error(`PID ${pid} has no process start time`);
  let executable = "";
  try { executable = await readlink(`/proc/${pid}/exe`); } catch {}
  return { pid, argv, startTime, executable };
}

export async function assertServiceIdentity(pid, entryFile, expectedStartTime = null) {
  const identity = await readServiceIdentity(pid, entryFile);
  if (expectedStartTime != null && identity.startTime !== String(expectedStartTime)) {
    throw new Error(`PID ${pid} was reused by a different process`);
  }
  return identity;
}

export function terminalPrompt(job, status) {
  const safeError = String(status.error || status.recoveryError || "").replace(/[\u0000-\u001f]+/g, " ").slice(0, 1000);
  if (status.state === "succeeded" && status.recovered) {
    return `System event: Safe Arisa restart job ${job.id} needed a recovery attempt, then reached stable health on PID ${status.newPid}. Tell the user briefly that Arisa is running again after an automatic retry.`;
  }
  if (status.state === "succeeded") {
    return `System event: Safe Arisa restart job ${job.id} completed and remained healthy on new PID ${status.newPid}. Tell the user briefly that the verified restart succeeded.`;
  }
  return `System event: Safe Arisa restart job ${job.id} failed during ${status.phase}. Manual attention may be required. Error: ${safeError}`;
}
