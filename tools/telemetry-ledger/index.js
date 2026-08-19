import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import defaults from "./config.js";
import { compareWindows, filterEvents, summarizeByMetric } from "./analysis.js";
import { appendRecords, pruneEvents, readDefinitions, readEvents, writeDefinitions } from "./storage.js";
import { validateDefinition, validateDimensions, validateMetricName, validateRecord } from "./validation.js";

const toolName = "telemetry-ledger";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { getChatToolStateDir } = await importCore("runtime/paths.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");

function printHelp() {
  console.log(`telemetry-ledger

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions:
  define   Define metrics. args.definitions=<JSON array>
  record   Append numeric measurements. args.records=<JSON array>
  query    Summarize a window. args.metrics?, since?, until?, windowHours?, dimensions?, includeEvents?, limit?
  compare  Compare adjacent windows. args.metrics?, currentHours?, baselineHours?, until?, dimensions?, groupBy?
  report   Compare all metrics over adjacent windows. args.currentHours?, baselineHours?, until?, groupBy?
  prune    Remove event files older than retention. args.retentionDays?

Metric kinds: counter, gauge, duration, event.
Directions: lower, higher, neutral.
All state is isolated by chat. Dimensions are bounded and reject credential/private-content keys.`);
}

function jsonArg(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { throw new Error("Expected valid JSON argument"); }
}

function listArg(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  const parsed = String(value).trim().startsWith("[") ? jsonArg(value, []) : String(value).split(",");
  return parsed.map((item) => String(item).trim()).filter(Boolean);
}

function positiveNumber(value, fallback, minimum = 0.001) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum) throw new Error("Expected a positive number");
  return number;
}

function windowRange(args) {
  const until = args.until ? new Date(args.until) : new Date();
  if (!Number.isFinite(until.getTime())) throw new Error("Invalid until timestamp");
  const hours = positiveNumber(args.windowHours, 24);
  return { since: new Date(until.getTime() - hours * 3600000), until };
}

async function loadWindow(stateDir, args, config) {
  const range = windowRange(args);
  const events = await readEvents(stateDir, { ...range, maximum: Number(config.MAX_QUERY_EVENTS) });
  return { ...range, events: filterEvents(events, { metrics: listArg(args.metrics), dimensions: validateDimensions(jsonArg(args.dimensions, {})) }) };
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    if (!request.chatId) throw new Error("chatId is required");
    const args = request.args || {};
    const action = String(args.action || "report").toLowerCase();
    const config = await loadToolConfig(toolName, defaults, request.chatId);
    const stateDir = getChatToolStateDir(request.chatId, toolName);
    const definitions = await readDefinitions(stateDir);

    if (action === "define") {
      const inputs = jsonArg(args.definitions, args.metric ? [args] : []);
      if (!Array.isArray(inputs) || !inputs.length) throw new Error("definitions must be a non-empty JSON array");
      for (const input of inputs) {
        const definition = validateDefinition(input);
        definitions[definition.metric] = definition;
      }
      await writeDefinitions(stateDir, definitions);
      console.log(JSON.stringify(toolOk({ text: `Defined ${inputs.length} metric(s).`, json: { definitions: Object.values(definitions) } })));
      return;
    }

    if (action === "record") {
      const inputs = jsonArg(args.records, args.metric ? [args] : []);
      if (!Array.isArray(inputs) || !inputs.length) throw new Error("records must be a non-empty JSON array");
      if (inputs.length > Number(config.MAX_RECORDS_PER_CALL)) throw new Error(`A maximum of ${config.MAX_RECORDS_PER_CALL} records is allowed`);
      const records = inputs.map((input) => validateRecord(input, definitions[validateMetricName(input.metric)]));
      await appendRecords(stateDir, records);
      console.log(JSON.stringify(toolOk({ text: `Recorded ${records.length} telemetry measurement(s).`, json: { recorded: records.length, metrics: [...new Set(records.map((record) => record.metric))] } })));
      return;
    }

    if (action === "query") {
      const window = await loadWindow(stateDir, args, config);
      const summaries = summarizeByMetric(window.events, definitions);
      const includeEvents = String(args.includeEvents || "false") === "true";
      const limit = Math.min(1000, Math.max(1, Number(args.limit || 100)));
      console.log(JSON.stringify(toolOk({ text: JSON.stringify(summaries, null, 2), json: { since: window.since, until: window.until, summaries, events: includeEvents ? window.events.slice(-limit) : undefined } })));
      return;
    }

    if (action === "compare" || action === "report") {
      const until = args.until ? new Date(args.until) : new Date();
      if (!Number.isFinite(until.getTime())) throw new Error("Invalid until timestamp");
      const currentHours = positiveNumber(args.currentHours, 24);
      const baselineHours = positiveNumber(args.baselineHours, currentHours);
      const currentSince = new Date(until.getTime() - currentHours * 3600000);
      const baselineSince = new Date(currentSince.getTime() - baselineHours * 3600000);
      const all = await readEvents(stateDir, { since: baselineSince, until, maximum: Number(config.MAX_QUERY_EVENTS) });
      const filter = { metrics: action === "report" ? [] : listArg(args.metrics), dimensions: validateDimensions(jsonArg(args.dimensions, {})) };
      const currentEvents = filterEvents(all.filter((event) => new Date(event.timestamp) >= currentSince), filter);
      const baselineEvents = filterEvents(all.filter((event) => new Date(event.timestamp) < currentSince), filter);
      const analysis = compareWindows({
        baselineEvents,
        currentEvents,
        definitions,
        thresholdPercent: positiveNumber(args.thresholdPercent, config.REGRESSION_THRESHOLD_PERCENT),
        minimumSamples: positiveNumber(args.minimumSamples, config.MIN_COMPARE_SAMPLES, 1),
        groupBy: listArg(args.groupBy)
      });
      const json = { baseline: { since: baselineSince, until: currentSince }, current: { since: currentSince, until }, ...analysis };
      console.log(JSON.stringify(toolOk({ text: JSON.stringify(json, null, 2), json })));
      return;
    }

    if (action === "prune") {
      const retentionDays = positiveNumber(args.retentionDays, config.RETENTION_DAYS, 1);
      const before = new Date(Date.now() - retentionDays * 86400000);
      const removedFiles = await pruneEvents(stateDir, before);
      console.log(JSON.stringify(toolOk({ text: `Pruned ${removedFiles} telemetry event file(s).`, json: { removedFiles, before } })));
      return;
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const cliArgs = process.argv.slice(2);
if (!cliArgs.length || cliArgs.includes("--help") || cliArgs[0] === "help") printHelp();
else if (cliArgs[0] === "run" && cliArgs.includes("--request-file")) await run(cliArgs[cliArgs.indexOf("--request-file") + 1]);
else printHelp();
