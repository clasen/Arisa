import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");

function printHelp() {
  console.log(`schedule-agent-task\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "text": "tell me the temperature in Toronto",\n    "artifact": { "text": "tell me the temperature in Toronto" },\n    "args": {\n      "prompt": "tell me the temperature in Toronto",\n      "runAt": "2026-04-07T14:00:00.000Z",\n      "delaySeconds": "30",\n      "intervalSeconds": "3600"\n    }\n  }\n\nBehavior:\n  - schedules a future agent task for the current chat\n  - provide either args.runAt or args.delaySeconds\n  - optional args.intervalSeconds makes the task recurring\n\nTool filter mode:\n  args.kind = \"poll_tool\" or args.toolName schedules a lightweight tool callback instead of an agent.\n  The tool can return asyncTask/asyncTasks only when it wants to wake the agent.\n  args.toolName: tool to run\n  args.toolArgs: JSON object passed as request.args to that tool\n`);
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function buildRunAt(args = {}) {
  const runAtValue = firstNonEmpty(args.runAt, args.at, args.when);
  if (runAtValue) {
    const parsed = Date.parse(runAtValue);
    if (Number.isNaN(parsed)) return "";
    return new Date(parsed).toISOString();
  }

  const delaySeconds = Number(firstNonEmpty(args.delaySeconds, args.delay, args.seconds));
  if (Number.isFinite(delaySeconds) && delaySeconds > 0) {
    return new Date(Date.now() + (delaySeconds * 1000)).toISOString();
  }

  return "";
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const args = request.args || {};
  const prompt = firstNonEmpty(args.prompt, args.message, args.task, request.text, request.artifact?.text);
  const runAt = buildRunAt(args);
  const intervalSeconds = Number(firstNonEmpty(args.intervalSeconds, args.interval, args.everySeconds));
  const toolName = firstNonEmpty(args.toolName, args.callbackTool, args.filterTool, args.pollTool);
  const kind = toolName ? "poll_tool" : String(args.kind || "agent_task");

  if (kind !== "poll_tool" && !prompt.trim()) {
    console.log(JSON.stringify(toolError("prompt/message/task, text, or artifact.text is required")));
    return;
  }

  if (kind === "poll_tool" && !toolName.trim()) {
    console.log(JSON.stringify(toolError("args.toolName/callbackTool/filterTool/pollTool is required for poll_tool")));
    return;
  }

  if (!runAt) {
    console.log(JSON.stringify(toolError("args.runAt/at/when or args.delaySeconds/delay/seconds is required")));
    return;
  }

  const asyncTask = {
    kind,
    runAt,
    payload: kind === "poll_tool"
      ? { toolName, args: typeof args.toolArgs === "string" ? JSON.parse(args.toolArgs || "{}") : (args.toolArgs || {}) }
      : { prompt },
    recurrence: Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? { type: "interval", everySeconds: intervalSeconds }
      : null
  };

  console.log(JSON.stringify(toolOk({ runAt }, {
    status: "scheduled",
    asyncTask
  })));
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") {
  printHelp();
} else if (args[0] === "run") {
  const fileIndex = args.indexOf("--request-file");
  await run(args[fileIndex + 1]);
} else {
  printHelp();
}
