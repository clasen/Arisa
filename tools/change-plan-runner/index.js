import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";
import { ChangePlanStore } from "./state-store.js";
import {
  approveAndStart,
  beginBatch,
  blockBatch,
  cancelPlan,
  completeBatch,
  inspectWorkspace,
  normalizeGitMode,
  normalizePlan,
  resumePlan,
  summarizePlan
} from "./change-plan.js";

const toolName = "change-plan-runner";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { getChatToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`change-plan-runner\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nActions:\n  create   Validate and persist a new plan without starting it.\n  start    Record plan-level owner approval and schedule the first batch.\n  status   Show the active plan and batch states.\n  begin    Mark the scheduled batch running before changes.\n  complete Verify evidence and optional Git boundaries, then schedule the next batch.\n  block    Stop progression and record why the active batch is blocked.\n  resume   Retry the blocked batch after owner/agent intervention.\n  cancel   Cancel the active plan.\n\nCreate example:\n  {\n    "action": "create",\n    "plan": {\n      "title": "Build a capability in stages",\n      "workspace": "/absolute/workspace/path",\n      "policy": { "gitMode": "auto" },\n      "batches": [{\n        "id": "contract",\n        "title": "Define the contract",\n        "objective": "Specify inputs, outputs, and safety boundaries.",\n        "checks": ["contract reviewed"]\n      }]\n    }\n  }\n\nGit modes:\n  auto      Use Git gates when the workspace is a repository; otherwise continue without Git.\n  required  Refuse to start unless Git validation is available.\n  disabled  Never invoke Git.\n\nSafety:\n  - create never starts work; start requires a separate owner-approved invocation\n  - only one batch is dispatched at a time\n  - failures block the plan instead of advancing\n  - the tool never edits files or runs arbitrary plan commands itself\n  - optional Git verification uses fixed read-only commands\n`);
}

function planInput(args) {
  if (typeof args.plan === "string") return JSON.parse(args.plan);
  if (args.plan && typeof args.plan === "object") return args.plan;
  return args;
}

function requirePlan(plan) {
  if (!plan) throw new Error("No active change plan");
  return plan;
}

async function handle(request) {
  if (request.chatId == null) throw new Error("chatId is required");
  const args = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? { ...request.args } : {};
  if (typeof args.evidence === "string") args.evidence = JSON.parse(args.evidence);
  const action = String(args.action || "status").trim().toLowerCase();
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const store = new ChangePlanStore(getChatToolStateDir(request.chatId, toolName));
  let asyncTask = null;
  let plan;

  if (action === "status") {
    plan = requirePlan(await store.read());
  } else if (action === "create") {
    const input = planInput(args);
    const gitMode = normalizeGitMode(input.policy?.gitMode || config.GIT_MODE || "auto");
    const workspaceInfo = await inspectWorkspace(input.workspace || input.repository, gitMode);
    plan = normalizePlan(input, config, workspaceInfo);
    if (plan.policy.requireCleanTree && !workspaceInfo.clean) throw new Error("Git worktree must be clean before creating a plan");
    await store.mutate((current) => {
      if (current && ["ready", "running", "blocked"].includes(current.status)) {
        throw new Error(`Active plan ${current.id} must be completed or cancelled first`);
      }
      return plan;
    });
  } else if (action === "start") {
    await store.mutate(async (current) => {
      const result = await approveAndStart(requirePlan(current), args.approvalNote);
      plan = result.plan;
      asyncTask = result.asyncTask;
      return plan;
    });
  } else if (action === "begin") {
    plan = await store.mutate((current) => beginBatch(requirePlan(current), args));
  } else if (action === "complete") {
    await store.mutate(async (current) => {
      const result = await completeBatch(requirePlan(current), args);
      plan = result.plan;
      asyncTask = result.asyncTask;
      return plan;
    });
  } else if (action === "block") {
    plan = await store.mutate((current) => blockBatch(requirePlan(current), args));
  } else if (action === "resume") {
    await store.mutate(async (current) => {
      const result = await resumePlan(requirePlan(current));
      plan = result.plan;
      asyncTask = result.asyncTask;
      return plan;
    });
  } else if (action === "cancel") {
    plan = await store.mutate((current) => cancelPlan(requirePlan(current), args.reason));
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  return toolOk({ json: summarizePlan(plan) }, {
    status: plan.status,
    ...(asyncTask ? { asyncTask } : {})
  });
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    console.log(JSON.stringify(await handle(request)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message)));
  }
}

const cliArgs = process.argv.slice(2);
if (!cliArgs.length || cliArgs.includes("--help") || cliArgs[0] === "help") {
  printHelp();
} else if (cliArgs[0] === "run") {
  const requestIndex = cliArgs.indexOf("--request-file");
  const requestFile = cliArgs[requestIndex + 1];
  if (!requestFile) {
    console.log(JSON.stringify(toolError("--request-file is required")));
  } else {
    await run(requestFile);
  }
} else {
  printHelp();
}
