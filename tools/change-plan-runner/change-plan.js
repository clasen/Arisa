import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTIVE_PLAN_STATES = new Set(["ready", "running", "blocked"]);
const BATCH_STATES = new Set(["pending", "scheduled", "running", "completed", "blocked"]);
const GIT_MODES = new Set(["auto", "required", "disabled"]);

function boundedText(value, label, maxLength = 4_000) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return text;
}

function optionalText(value, maxLength = 4_000) {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw new Error(`Text exceeds ${maxLength} characters`);
  return text;
}

function stringList(values, label, maxItems = 20) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  return values.map((value, index) => boundedText(value, `${label}[${index}]`, 500));
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function currentBatch(plan) {
  return plan.batches.find((batch) => ["scheduled", "running", "blocked"].includes(batch.status)) || null;
}

function nextPendingBatch(plan) {
  return plan.batches.find((batch) => batch.status === "pending") || null;
}

async function git(repository, args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1_048_576
  });
  return stdout.trim();
}

export function normalizeGitMode(value = "auto") {
  const mode = String(value || "auto").trim().toLowerCase();
  if (!GIT_MODES.has(mode)) throw new Error(`Unsupported Git mode: ${mode}`);
  return mode;
}

export async function inspectRepository(repository) {
  const root = path.resolve(await git(repository, ["rev-parse", "--show-toplevel"]));
  const head = await git(root, ["rev-parse", "HEAD"]);
  const status = await git(root, ["status", "--porcelain"]);
  let upstream = "";
  let ahead = null;
  try {
    upstream = await git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    ahead = Number(await git(root, ["rev-list", "--count", "@{upstream}..HEAD"]));
  } catch {}
  return { root, git: true, gitRoot: root, head, clean: !status, upstream, ahead };
}

export async function inspectWorkspace(workspace, gitMode = "auto") {
  const root = path.resolve(boundedText(workspace, "plan.workspace", 4_000));
  const details = await stat(root).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`Workspace does not exist: ${root}`);
    throw error;
  });
  if (!details.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  const mode = normalizeGitMode(gitMode);
  if (mode === "disabled") return { root, git: false, gitRoot: null, head: null, clean: null, upstream: "", ahead: null };
  try {
    const repository = await inspectRepository(root);
    return { ...repository, root };
  } catch (error) {
    if (mode === "required") throw new Error(`Git validation is required for ${root}: ${error.message}`);
    return { root, git: false, gitRoot: null, head: null, clean: null, upstream: "", ahead: null };
  }
}

export function normalizePlan(input, config, workspaceInfo, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("plan must be an object");
  if (!Array.isArray(input.batches) || !input.batches.length) throw new Error("plan.batches must contain at least one batch");
  const maxBatches = Number(config.MAX_BATCHES) || 20;
  if (input.batches.length > maxBatches) throw new Error(`plan exceeds the ${maxBatches}-batch limit`);
  const ids = new Set();
  const batches = input.batches.map((batch, index) => {
    const id = boundedText(batch.id || `batch-${index + 1}`, `batches[${index}].id`, 80);
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(id)) throw new Error(`Invalid batch id: ${id}`);
    if (ids.has(id)) throw new Error(`Duplicate batch id: ${id}`);
    ids.add(id);
    return {
      id,
      title: boundedText(batch.title, `batches[${index}].title`, 200),
      objective: boundedText(batch.objective, `batches[${index}].objective`),
      instructions: optionalText(batch.instructions),
      checks: stringList(batch.checks, `batches[${index}].checks`),
      afterComplete: optionalText(batch.afterComplete, 1_000),
      status: "pending",
      attempt: 0,
      baseHead: null,
      evidence: null,
      startedAt: null,
      completedAt: null
    };
  });
  const createdAt = now.toISOString();
  const gitEnabled = Boolean(workspaceInfo.git);
  return {
    version: 2,
    id: crypto.randomUUID(),
    title: boundedText(input.title, "plan.title", 200),
    workspace: workspaceInfo.root,
    repository: workspaceInfo.gitRoot,
    status: "ready",
    approved: false,
    approvalNote: optionalText(input.approvalNote, 500),
    policy: {
      gitMode: normalizeGitMode(input.policy?.gitMode || config.GIT_MODE || "auto"),
      gitEnabled,
      requireCleanTree: gitEnabled && booleanValue(input.policy?.requireCleanTree, Boolean(config.REQUIRE_CLEAN_TREE)),
      requireCommit: gitEnabled && booleanValue(input.policy?.requireCommit, Boolean(config.REQUIRE_COMMIT)),
      requirePush: gitEnabled && booleanValue(input.policy?.requirePush, Boolean(config.REQUIRE_PUSH)),
      nextBatchDelaySeconds: Math.max(1, Number(input.policy?.nextBatchDelaySeconds || config.NEXT_BATCH_DELAY_SECONDS || 15))
    },
    repositoryBaseline: workspaceInfo.head,
    batches,
    createdAt,
    updatedAt: createdAt,
    approvedAt: null,
    completedAt: null,
    blockedReason: null
  };
}

function batchPrompt(plan, batch) {
  const requiredChecks = batch.checks.length
    ? batch.checks.map((check) => `- ${check}`).join("\n")
    : "- No named checks were declared; run the smallest relevant validation for this batch.";
  const evidenceExample = Object.fromEntries(batch.checks.map((check) => [check, "passed"]));
  const gitRule = plan.policy.gitEnabled
    ? `Leave the Git worktree clean. ${plan.policy.requireCommit ? `Commit${plan.policy.requirePush ? " and push" : ""} this batch.` : "Respect the declared Git boundary."} Do not include unrelated changes.`
    : "Git is not required for this plan. Keep changes bounded to this workspace and do not assume version control is installed.";
  const commitEvidence = plan.policy.requireCommit ? ", evidence.commit" : "";
  return `Execute one owner-approved change batch.\n\nPlan: ${plan.title}\nPlan ID: ${plan.id}\nWorkspace: ${plan.workspace || plan.repository}\nBatch: ${batch.id} — ${batch.title}\nObjective: ${batch.objective}\n${batch.instructions ? `Instructions: ${batch.instructions}\n` : ""}\nRules:\n1. Call change-plan-runner action=begin with planId=${plan.id} and batchId=${batch.id} before making changes.\n2. Inspect the workspace and its local instructions before changing it.\n3. Implement only this batch; do not start later batches.\n4. Preserve compatibility unless this batch explicitly says otherwise.\n5. Run all required checks. If blocked or any check fails, call action=block with a concise reason; do not continue.\n6. ${gitRule}\n7. On success call action=complete with planId, batchId, evidence.summary${commitEvidence}, and evidence.checks. The tool alone schedules the next batch.\n\nRequired checks:\n${requiredChecks}\n\nEvidence checks object: ${JSON.stringify(evidenceExample)}${batch.afterComplete ? `\n\nAfter action=complete succeeds: ${batch.afterComplete}` : ""}`;
}

function scheduledTask(plan, batch, delaySeconds = plan.policy.nextBatchDelaySeconds) {
  return {
    kind: "agent_task",
    runAt: new Date(Date.now() + (delaySeconds * 1_000)).toISOString(),
    payload: { prompt: batchPrompt(plan, batch) },
    recurrence: null
  };
}

async function inspectPlanWorkspace(plan) {
  const legacyGit = plan.policy.gitEnabled ?? Boolean(plan.repository && (
    plan.policy.requireCleanTree || plan.policy.requireCommit || plan.policy.requirePush
  ));
  const mode = plan.policy.gitMode || (legacyGit ? "required" : "disabled");
  return inspectWorkspace(plan.workspace || plan.repository, mode);
}

async function prepareBatch(plan, batch) {
  const workspace = await inspectPlanWorkspace(plan);
  if (plan.policy.requireCleanTree && !workspace.clean) throw new Error("Git worktree must be clean before scheduling a batch");
  batch.status = "scheduled";
  batch.baseHead = workspace.head;
  batch.attempt += 1;
  plan.status = "running";
  plan.blockedReason = null;
  plan.updatedAt = new Date().toISOString();
  return scheduledTask(plan, batch);
}

export function summarizePlan(plan) {
  return {
    id: plan.id,
    title: plan.title,
    workspace: plan.workspace || plan.repository,
    repository: plan.repository || null,
    gitEnabled: Boolean(plan.policy?.gitEnabled ?? plan.repository),
    status: plan.status,
    approved: plan.approved,
    currentBatch: currentBatch(plan)?.id || null,
    batches: plan.batches.map(({ id, title, status, attempt }) => ({ id, title, status, attempt })),
    updatedAt: plan.updatedAt
  };
}

export async function approveAndStart(plan, approvalNote = "") {
  if (plan.status !== "ready") throw new Error(`Plan cannot start from status ${plan.status}`);
  plan.approved = true;
  plan.approvalNote = optionalText(approvalNote || plan.approvalNote, 500);
  plan.approvedAt = new Date().toISOString();
  const asyncTask = await prepareBatch(plan, nextPendingBatch(plan));
  return { plan, asyncTask };
}

export function beginBatch(plan, { planId, batchId }) {
  if (plan.id !== planId) throw new Error("Plan id does not match the active plan");
  const batch = currentBatch(plan);
  if (!batch || batch.id !== batchId) throw new Error("Batch id does not match the scheduled batch");
  if (batch.status !== "scheduled") throw new Error(`Batch cannot begin from status ${batch.status}`);
  batch.status = "running";
  batch.startedAt = new Date().toISOString();
  plan.updatedAt = batch.startedAt;
  return plan;
}

function validateChecks(batch, evidence) {
  for (const check of batch.checks) {
    if (evidence?.checks?.[check] !== "passed") throw new Error(`Missing passing evidence for check: ${check}`);
  }
}

export async function completeBatch(plan, { planId, batchId, evidence = {} }) {
  if (plan.id !== planId) throw new Error("Plan id does not match the active plan");
  const batch = currentBatch(plan);
  if (!batch || batch.id !== batchId) throw new Error("Batch id does not match the running batch");
  if (batch.status !== "running") throw new Error(`Batch cannot complete from status ${batch.status}`);
  const summary = boundedText(evidence.summary, "evidence.summary", 2_000);
  validateChecks(batch, evidence);
  const workspace = await inspectPlanWorkspace(plan);
  if (plan.policy.requireCleanTree && !workspace.clean) throw new Error("Git worktree is not clean");
  if (plan.policy.requireCommit) {
    if (workspace.head === batch.baseHead) throw new Error("Batch did not produce a new commit");
    if (String(evidence.commit || "").trim() !== workspace.head) throw new Error("evidence.commit must equal the repository HEAD");
  }
  if (plan.policy.requirePush && (!workspace.upstream || workspace.ahead !== 0)) {
    throw new Error("Batch HEAD is not present on the configured upstream branch");
  }
  const completedAt = new Date().toISOString();
  batch.status = "completed";
  batch.completedAt = completedAt;
  batch.evidence = {
    summary,
    commit: workspace.head,
    checks: evidence.checks || {},
    pushed: plan.policy.requirePush,
    recordedAt: completedAt
  };
  const next = nextPendingBatch(plan);
  if (!next) {
    plan.status = "completed";
    plan.completedAt = completedAt;
    plan.updatedAt = completedAt;
    return { plan, asyncTask: null };
  }
  const asyncTask = await prepareBatch(plan, next);
  return { plan, asyncTask };
}

export function blockBatch(plan, { planId, batchId, reason }) {
  if (plan.id !== planId) throw new Error("Plan id does not match the active plan");
  const batch = currentBatch(plan);
  if (!batch || batch.id !== batchId || !BATCH_STATES.has(batch.status)) throw new Error("Batch id does not match the active batch");
  const blockedAt = new Date().toISOString();
  batch.status = "blocked";
  batch.evidence = { reason: boundedText(reason, "reason", 2_000), recordedAt: blockedAt };
  plan.status = "blocked";
  plan.blockedReason = batch.evidence.reason;
  plan.updatedAt = blockedAt;
  return plan;
}

export async function resumePlan(plan) {
  if (plan.status !== "blocked") throw new Error(`Plan cannot resume from status ${plan.status}`);
  const batch = currentBatch(plan);
  if (!batch || batch.status !== "blocked") throw new Error("Blocked plan has no blocked batch");
  batch.status = "pending";
  const asyncTask = await prepareBatch(plan, batch);
  return { plan, asyncTask };
}

export function cancelPlan(plan, reason = "Cancelled by owner") {
  if (!ACTIVE_PLAN_STATES.has(plan.status)) throw new Error(`Plan cannot be cancelled from status ${plan.status}`);
  const batch = currentBatch(plan);
  if (batch && batch.status !== "completed") batch.status = "blocked";
  plan.status = "cancelled";
  plan.blockedReason = optionalText(reason, 2_000) || "Cancelled by owner";
  plan.updatedAt = new Date().toISOString();
  return plan;
}
