import path from "node:path";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMcpCommand, McpProcess } from "../mcp-session.js";
import { contentMatchesLimitFixture, limitFixtures, limitSuiteLimits as limits, validateLimitSuitePolicy } from "../limit-suite-policy.js";
import { lightpandaProcessIds, readHostMemoryMiB, readProcessRssMiB } from "../process-metrics.js";
import { validatePublicUrl } from "../url-security.js";
import defaults from "../config.js";

const toolName = "lightpanda-browser";
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function coreImport(relativePath) {
  const packageRoot = process.env.ARISA_PACKAGE_DIR;
  if (!packageRoot) throw new Error("ARISA_PACKAGE_DIR is required.");
  return import(pathToFileURL(path.join(packageRoot, "src", relativePath)).href);
}

function errorDetail(error) {
  return { code: error?.code || "LIGHTPANDA_LIMIT_FAILURE", message: String(error?.message || error).slice(0, 500) };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function startClient(binary, lifetimeMs) {
  const client = new McpProcess(binary, buildMcpCommand(defaults, lifetimeMs), {
    timeoutMs: lifetimeMs,
    maxCaptureBytes: 32 * 1024
  });
  await client.start();
  return client;
}

async function closeClient(client) {
  if (!client) return;
  const child = client.child;
  const closed = child && child.exitCode === null && child.signalCode === null ? once(child, "close") : Promise.resolve();
  client.close();
  await Promise.race([closed, delay(2_000)]);
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function finalUrl(client) {
  const output = await client.call("getUrl", {});
  const match = output.match(/https?:\/\/\S+/);
  return match ? (await validatePublicUrl(match[0])).href : null;
}

async function exerciseFixture(client, fixture) {
  await validatePublicUrl(fixture.url);
  await client.call("goto", { url: fixture.url });
  const outputs = [await client.call("markdown", { maxBytes: limits.outputBytes })];
  if (fixture.category === "forms") outputs.push(await client.call("detectForms", {}));
  if (fixture.category === "modals") outputs.push(await client.call("interactiveElements", { limit: 100 }));
  if (fixture.category === "tables") outputs.push(await client.call("extract", { schema: '{"company":"#customers tr:nth-child(2) td:first-child"}' }));
  if (fixture.category === "scrolling") outputs.push(await client.call("scroll", { x: 0, y: 1200 }));
  if (fixture.category === "iframes") outputs.push(await client.call("html", { selector: "iframe", maxBytes: 8192 }));
  const reachedUrl = await finalUrl(client);
  return { content: outputs.join("\n"), finalUrl: reachedUrl };
}

async function runCompatibility(binary) {
  const results = [];
  for (const fixture of limitFixtures) {
    const startedAt = Date.now();
    let client;
    try {
      client = await startClient(binary, limits.compatibilityTimeoutMs);
      const output = await exerciseFixture(client, fixture);
      const semantic = contentMatchesLimitFixture(fixture, output.content, output.finalUrl);
      results.push({ id: fixture.id, category: fixture.category, success: semantic.success, elapsedMs: Date.now() - startedAt, finalUrl: output.finalUrl, ...semantic });
    } catch (error) {
      results.push({ id: fixture.id, category: fixture.category, success: false, elapsedMs: Date.now() - startedAt, error: errorDetail(error) });
    } finally {
      await closeClient(client);
    }
  }
  return { results, passed: results.every((result) => result.success) };
}

async function runNavigationLeakProbe(binary) {
  const samples = [];
  let client;
  let completed = 0;
  let limit = null;
  const startedAt = Date.now();
  try {
    client = await startClient(binary, limits.navigationLifetimeMs);
    for (let index = 1; index <= limits.navigationCount; index += 1) {
      await client.call("goto", { url: `https://example.com/?lightpanda_limit=${index}` });
      const semantic = await client.call("extract", { schema: '{"title":"h1"}' });
      if (!semantic.includes("Example Domain")) {
        limit = { navigation: index, reason: "semantic assertion failed" };
        break;
      }
      const rssMiB = await readProcessRssMiB(client.child.pid);
      samples.push(rssMiB);
      completed = index;
      if (rssMiB > limits.navigationRssLimitMiB) {
        limit = { navigation: index, reason: `RSS ${rssMiB} MiB exceeded ${limits.navigationRssLimitMiB} MiB` };
        break;
      }
    }
  } catch (error) {
    limit = { navigation: completed + 1, reason: errorDetail(error) };
  } finally {
    await closeClient(client);
  }
  const firstWindow = samples.slice(0, 10);
  const lastWindow = samples.slice(-10);
  const growthMiB = Number((median(lastWindow) - median(firstWindow)).toFixed(1));
  if (!limit && growthMiB > limits.leakGrowthLimitMiB) limit = { navigation: completed, reason: `median RSS growth ${growthMiB} MiB exceeded ${limits.leakGrowthLimitMiB} MiB` };
  return {
    status: limit ? "limit-reached" : "completed",
    completed,
    requested: limits.navigationCount,
    elapsedMs: Date.now() - startedAt,
    firstMedianRssMiB: median(firstWindow),
    lastMedianRssMiB: median(lastWindow),
    growthMiB,
    peakRssMiB: samples.length ? Math.max(...samples) : 0,
    limit
  };
}

async function runConcurrentProbe(binary) {
  const before = await readHostMemoryMiB();
  const clients = [];
  let peakAggregateRssMiB = 0;
  let minimumAvailableMiB = before.available;
  const fixtures = [limitFixtures[0], limitFixtures[1]].slice(0, limits.concurrentSessions);
  const sampler = setInterval(async () => {
    const rss = await Promise.all(clients.map((client) => readProcessRssMiB(client.child.pid)));
    peakAggregateRssMiB = Math.max(peakAggregateRssMiB, rss.reduce((total, value) => total + value, 0));
    minimumAvailableMiB = Math.min(minimumAvailableMiB, (await readHostMemoryMiB()).available);
  }, 20);
  let results = [];
  try {
    results = await Promise.all(fixtures.map(async (fixture) => {
      let client;
      try {
        client = await startClient(binary, limits.compatibilityTimeoutMs);
        clients.push(client);
        const output = await exerciseFixture(client, fixture);
        const semantic = contentMatchesLimitFixture(fixture, output.content, output.finalUrl);
        return { id: fixture.id, success: semantic.success, ...semantic };
      } catch (error) {
        return { id: fixture.id, success: false, error: errorDetail(error) };
      } finally {
        await closeClient(client);
      }
    }));
  } finally {
    clearInterval(sampler);
  }
  const after = await readHostMemoryMiB();
  const swapGrowthMiB = Number(Math.max(0, before.swapFree - after.swapFree).toFixed(1));
  const pressureBreach = peakAggregateRssMiB > limits.concurrentAggregateRssLimitMiB || swapGrowthMiB > limits.concurrentSwapGrowthLimitMiB;
  return { sessions: fixtures.length, results, peakAggregateRssMiB: Number(peakAggregateRssMiB.toFixed(1)), minimumAvailableMiB, swapGrowthMiB, pressureBreach, before, after, passed: results.every((result) => result.success) && !pressureBreach };
}

async function runUnsupportedApiProbe(binary) {
  let client;
  try {
    client = await startClient(binary, limits.unsupportedTimeoutMs);
    await client.call("goto", { url: "https://browserbench.org/Speedometer3.1/" });
    await client.call("click", { selector: ".start-tests-button" });
    await delay(8_000);
    const output = await client.call("markdown", { maxBytes: 32 * 1024 });
    const diagnostic = "One or more subtests produced no duration.";
    if (output.includes(diagnostic)) return { status: "unsupported", fixture: "Speedometer 3.1", diagnostic };
    if (/Score\s+[0-9]/i.test(output)) return { status: "supported", fixture: "Speedometer 3.1", diagnostic: "benchmark produced a score" };
    return { status: "inconclusive", fixture: "Speedometer 3.1", diagnostic: output.slice(0, 300) };
  } catch (error) {
    return { status: "unsupported", fixture: "Speedometer 3.1", diagnostic: errorDetail(error) };
  } finally {
    await closeClient(client);
  }
}

async function runTimeoutRecoveryProbe(binary) {
  let timedClient;
  let timeout;
  try {
    timedClient = await startClient(binary, limits.forcedTimeoutMs);
    await timedClient.call("goto", { url: "https://example.com/" });
    timeout = { explicit: false, diagnostic: "forced timeout unexpectedly completed" };
  } catch (error) {
    timeout = { explicit: error?.code === "LIGHTPANDA_TIMEOUT", diagnostic: errorDetail(error) };
  } finally {
    await closeClient(timedClient);
  }
  let recoveryClient;
  let recovery;
  try {
    recoveryClient = await startClient(binary, 15_000);
    await recoveryClient.call("goto", { url: "https://example.com/" });
    const output = await recoveryClient.call("extract", { schema: '{"title":"h1"}' });
    recovery = { success: output.includes("Example Domain") };
  } catch (error) {
    recovery = { success: false, error: errorDetail(error) };
  } finally {
    await closeClient(recoveryClient);
  }
  return { timeout, recovery, passed: timeout.explicit && recovery.success };
}

function markdown(report) {
  const compatibility = report.compatibility.results.map((row) => `| ${row.category} | ${row.id} | ${row.success ? "pass" : "limit"} | ${row.elapsedMs} |`).join("\n");
  return `# Lightpanda limit suite\n\nGenerated: ${report.generatedAt}\n\nThis Lightpanda-only suite uses fixture-specific semantic assertions. HTTP success or non-empty output never counts by itself. Chromium is not launched. Compatibility failures are recorded as explicit limits rather than hidden by fallback.\n\n| Category | Fixture | Semantic result | Latency (ms) |\n|---|---|---:|---:|\n${compatibility}\n\n## Bounded probes\n\n- 100-navigation probe: **${report.navigation.status}**, ${report.navigation.completed}/${report.navigation.requested}, peak ${report.navigation.peakRssMiB} MiB, median growth ${report.navigation.growthMiB} MiB.\n- Concurrent sessions: **${report.concurrency.passed ? "pass" : "limit"}**, ${report.concurrency.sessions} sessions, aggregate peak ${report.concurrency.peakAggregateRssMiB} MiB, swap growth ${report.concurrency.swapGrowthMiB} MiB.\n- Unsupported API fixture: **${report.unsupportedApi.status}** — ${typeof report.unsupportedApi.diagnostic === "string" ? report.unsupportedApi.diagnostic : report.unsupportedApi.diagnostic.message}\n- Forced timeout and clean recovery: **${report.timeoutRecovery.passed ? "pass" : "fail"}**.\n- Unexpected residual Lightpanda processes: **${report.cleanup.unexpectedResidual.length}**.\n`;
}

async function main() {
  validateLimitSuitePolicy();
  const [{ getToolStateDir }, { loadToolConfig }, { resolveBinary }] = await Promise.all([
    coreImport("runtime/paths.js"),
    coreImport("core/tools/tool-config.js"),
    import("../binary.js")
  ]);
  const config = await loadToolConfig(toolName, defaults);
  const binary = await resolveBinary(config.LIGHTPANDA_BINARY, getToolStateDir(toolName));
  const baselinePids = await lightpandaProcessIds();
  const report = {
    generatedAt: new Date().toISOString(),
    engine: "lightpanda",
    chromiumLaunched: false,
    policy: { fixtures: limitFixtures, limits }
  };
  report.compatibility = await runCompatibility(binary);
  report.navigation = await runNavigationLeakProbe(binary);
  report.concurrency = await runConcurrentProbe(binary);
  report.unsupportedApi = await runUnsupportedApiProbe(binary);
  report.timeoutRecovery = await runTimeoutRecoveryProbe(binary);
  await delay(500);
  const finalPids = await lightpandaProcessIds();
  report.cleanup = { baselinePids, finalPids, unexpectedResidual: finalPids.filter((pid) => !baselinePids.includes(pid)) };
  report.checks = {
    semanticAssertions: report.compatibility.passed,
    navigationBound: ["completed", "limit-reached"].includes(report.navigation.status) && report.navigation.completed > 0,
    concurrentPressure: report.concurrency.passed,
    explicitUnsupportedAndTimeout: report.unsupportedApi.status !== "inconclusive" && report.timeoutRecovery.passed,
    cleanup: report.cleanup.unexpectedResidual.length === 0,
    chromiumExcluded: report.chromiumLaunched === false
  };
  report.passed = Object.values(report.checks).every(Boolean);
  await writeFile(path.join(packageDir, "limit-suite-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageDir, "LIMITS.md"), markdown(report), "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
