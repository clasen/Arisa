import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { benchmarkEngines, benchmarkFixtures, benchmarkLimits, contentMatchesFixture, validateBenchmarkPolicy } from "../benchmark-policy.js";
import { buildFetchArgs } from "../browser-operation.js";
import { defaultBinaryPath } from "../binary.js";

const toolName = "lightpanda-browser";
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function coreImport(relativePath) {
  const arisaPackageDir = process.env.ARISA_PACKAGE_DIR;
  if (!arisaPackageDir) throw new Error("ARISA_PACKAGE_DIR is required.");
  return import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
}

async function processSnapshot() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const rows = [];
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    try {
      const pid = Number(entry.name);
      const [stat, status] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8")
      ]);
      const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(afterName[1]);
      const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
      rows.push({ pid, ppid, rssKiB });
    } catch {
      // The process exited while sampling.
    }
  }));
  return rows;
}

async function treeRssKiB(rootPid) {
  const rows = await processSnapshot();
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid)).reduce((total, row) => total + row.rssKiB, 0);
}

function runMeasured(command, args, { timeoutMs, captureBytes, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let peakRssKiB = 0;
    let timedOut = false;
    const capture = (target, counter) => (chunk) => {
      const used = counter === "stdout" ? stdoutBytes : stderrBytes;
      const available = Math.max(0, captureBytes - used);
      if (available > 0) target.push(chunk.subarray(0, available));
      if (counter === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
    };
    child.stdout.on("data", capture(stdout, "stdout"));
    child.stderr.on("data", capture(stderr, "stderr"));
    child.on("error", (error) => stderr.push(Buffer.from(error.message)));
    const sampler = setInterval(async () => {
      peakRssKiB = Math.max(peakRssKiB, await treeRssKiB(child.pid));
    }, 20);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, timeoutMs);
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      clearInterval(sampler);
      peakRssKiB = Math.max(peakRssKiB, await treeRssKiB(child.pid));
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        code, signal, timedOut, elapsedMs: Number(elapsedMs.toFixed(1)),
        peakRssMiB: Number((peakRssKiB / 1024).toFixed(1)),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutBytes, stderrBytes
      });
    });
  });
}

async function findChromium() {
  const configured = String(process.env.CHROMIUM_PATH || "").trim();
  if (configured) return configured;
  const roots = [path.join(os.homedir(), ".cache", "ms-playwright"), path.join(os.homedir(), ".cache", "puppeteer", "chrome")];
  const candidates = [];
  for (const root of roots) {
    try {
      for (const version of await readdir(root)) {
        for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
          const candidate = path.join(root, version, relative);
          try { await access(candidate); candidates.push(candidate); } catch {}
        }
      }
    } catch {}
  }
  return candidates.sort().at(-1) || "";
}

function outcome(engine, fixture, measured, success, contentBytes, detail = "") {
  return {
    engine,
    fixture: fixture.id,
    url: fixture.url,
    success,
    elapsedMs: measured.elapsedMs,
    peakRssMiB: measured.peakRssMiB,
    contentBytes,
    exitCode: measured.code,
    timedOut: measured.timedOut,
    detail: detail.slice(0, 240)
  };
}

async function runLightpanda(fixture, binary) {
  const specification = buildFetchArgs(new URL(fixture.url), "open", { TIMEOUT_MS: benchmarkLimits.timeoutMs, MAX_OUTPUT_BYTES: 64 * 1024, OBEY_ROBOTS: true }, { waitUntil: "networkidle" });
  const measured = await runMeasured(binary, specification.command, benchmarkLimits);
  try {
    const payload = JSON.parse(measured.stdout);
    const content = payload.content || "";
    const bytes = Buffer.byteLength(content);
    const semanticMatch = contentMatchesFixture(fixture, content);
    return outcome("lightpanda", fixture, measured, measured.code === 0 && !payload.error && semanticMatch, bytes, payload.error || (!semanticMatch ? "semantic assertion failed" : measured.stderr));
  } catch {
    return outcome("lightpanda", fixture, measured, false, 0, measured.stderr || "invalid JSON response");
  }
}

async function runWebBrowser(fixture, webBrowserEntry, requestFile) {
  await writeFile(requestFile, JSON.stringify({ text: fixture.url, args: { mode: "open", url: fixture.url } }), "utf8");
  const measured = await runMeasured(process.execPath, [webBrowserEntry, "run", "--request-file", requestFile], {
    ...benchmarkLimits,
    env: { ...process.env, ARISA_PACKAGE_DIR: process.env.ARISA_PACKAGE_DIR }
  });
  try {
    const payload = JSON.parse(measured.stdout);
    const content = payload.output?.text || "";
    const semanticMatch = contentMatchesFixture(fixture, content);
    return outcome("web-browser", fixture, measured, payload.ok === true && semanticMatch, Buffer.byteLength(content), payload.error || (!semanticMatch ? "semantic assertion failed" : measured.stderr));
  } catch {
    return outcome("web-browser", fixture, measured, false, 0, measured.stderr || "invalid JSON response");
  }
}

async function runChromium(fixture, chromium, profileDir) {
  if (!chromium) return { engine: "chromium", fixture: fixture.id, url: fixture.url, success: false, skipped: true, detail: "Chromium executable unavailable" };
  const measured = await runMeasured(chromium, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-extensions", `--user-data-dir=${profileDir}`,
    "--dump-dom", fixture.url
  ], benchmarkLimits);
  const semanticMatch = contentMatchesFixture(fixture, measured.stdout);
  return outcome("chromium", fixture, measured, measured.code === 0 && semanticMatch, measured.stdoutBytes, !semanticMatch && measured.code === 0 ? "semantic assertion failed" : measured.stderr);
}

function summarize(results) {
  return benchmarkEngines.map((engine) => {
    const rows = results.filter((result) => result.engine === engine && !result.skipped);
    const successful = rows.filter((result) => result.success);
    return {
      engine,
      attempted: rows.length,
      succeeded: successful.length,
      successRate: rows.length ? Number((successful.length / rows.length).toFixed(2)) : null,
      medianElapsedMs: rows.length ? rows.map((row) => row.elapsedMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] : null,
      medianPeakRssMiB: rows.length ? rows.map((row) => row.peakRssMiB).sort((a, b) => a - b)[Math.floor(rows.length / 2)] : null
    };
  });
}

function markdown(report) {
  const rows = report.summary.map((row) => `| ${row.engine} | ${row.succeeded}/${row.attempted} | ${row.medianElapsedMs ?? "n/a"} | ${row.medianPeakRssMiB ?? "n/a"} |`);
  return `# Lightpanda browser benchmark\n\nGenerated: ${report.generatedAt}\n\nThis is a bounded directional benchmark: three anonymous public HTTPS pages, one run per engine and page. Success requires fixture-specific semantic content, not merely HTTP 200 or non-empty output. Network variance means the latency values are not a durable performance claim. Peak RSS is the sampled process-tree resident set, not heap. Medians include failed and timed-out attempts so resource cost is not hidden.\n\n| Engine | Success | Median observed latency (ms) | Median observed peak RSS (MiB) |\n|---|---:|---:|---:|\n${rows.join("\n")}\n\n## Switching guidance\n\n1. Use \`web-browser\` first for search and static/readable pages; it has no rendering engine.\n2. Use \`lightpanda-browser\` for anonymous public pages that require JavaScript or rendered-DOM extraction.\n3. Select Chromium explicitly for authenticated sessions, unsupported browser APIs, visual fidelity, downloads, CAPTCHA, or payment authentication.\n4. A Lightpanda compatibility failure never triggers Chromium automatically.\n5. Keep browser outputs bounded because the active Pi session, not browser subprocess RSS, caused the observed worker OOM.\n\nRaw bounded results are stored in \`benchmark-latest.json\`.\n`;
}

async function main() {
  validateBenchmarkPolicy();
  const { getToolStateDir, getToolTmpDir, getToolDir } = await coreImport("runtime/paths.js");
  const stateDir = getToolStateDir(toolName);
  const temporaryDir = path.join(getToolTmpDir(toolName), `benchmark-${process.pid}-${Date.now()}`);
  const binary = defaultBinaryPath(stateDir);
  const includeChromium = String(process.env.INCLUDE_CHROMIUM || "").toLowerCase() === "true";
  const chromium = includeChromium ? await findChromium() : "";
  const webBrowserEntry = path.join(getToolDir("web-browser"), "index.js");
  const results = [];
  await mkdir(temporaryDir, { recursive: true });
  try {
    for (const fixture of benchmarkFixtures) {
      results.push(await runWebBrowser(fixture, webBrowserEntry, path.join(temporaryDir, `${fixture.id}-web.json`)));
      results.push(await runLightpanda(fixture, binary));
      results.push(includeChromium
        ? await runChromium(fixture, chromium, path.join(temporaryDir, `${fixture.id}-chrome`))
        : { engine: "chromium", fixture: fixture.id, url: fixture.url, success: false, skipped: true, detail: "Chromium excluded by default; set INCLUDE_CHROMIUM=true explicitly" });
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    policy: { fixtures: benchmarkFixtures, runsPerPage: benchmarkLimits.runsPerPage, timeoutMs: benchmarkLimits.timeoutMs, authenticatedSessions: false },
    chromiumRequested: includeChromium,
    chromiumAvailable: includeChromium && Boolean(chromium),
    results,
    summary: summarize(results)
  };
  await writeFile(path.join(packageDir, "benchmark-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageDir, "BENCHMARK.md"), markdown(report), "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
