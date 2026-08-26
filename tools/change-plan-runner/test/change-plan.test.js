import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  approveAndStart,
  beginBatch,
  blockBatch,
  completeBatch,
  inspectRepository,
  inspectWorkspace,
  normalizePlan,
  resumePlan
} from "../change-plan.js";
import { ChangePlanStore } from "../state-store.js";

const execFileAsync = promisify(execFile);

async function git(repository, ...args) {
  return (await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8" })).stdout.trim();
}

async function createRepository() {
  const repository = await mkdtemp(path.join(os.tmpdir(), "change-plan-runner-"));
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "Arisa Test");
  await git(repository, "config", "user.email", "arisa@example.invalid");
  await writeFile(path.join(repository, "file.txt"), "initial\n", "utf8");
  await git(repository, "add", "file.txt");
  await git(repository, "commit", "-qm", "Initial");
  return repository;
}

const config = {
  MAX_BATCHES: 5,
  NEXT_BATCH_DELAY_SECONDS: 1,
  REQUIRE_CLEAN_TREE: true,
  REQUIRE_COMMIT: true,
  REQUIRE_PUSH: false
};

function input(repository) {
  return {
    title: "Safe refactor",
    repository,
    batches: [
      { id: "first", title: "First batch", objective: "Make the first bounded change.", checks: ["targeted"] },
      { id: "second", title: "Second batch", objective: "Make the second bounded change.", checks: ["full suite"] }
    ]
  };
}

test("advances one verified committed batch at a time", async () => {
  const repository = await createRepository();
  try {
    const plan = normalizePlan(input(repository), config, await inspectRepository(repository));
    const started = await approveAndStart(plan, "Owner approved the complete plan");
    assert.equal(started.plan.batches[0].status, "scheduled");
    assert.equal(started.plan.batches[1].status, "pending");
    assert.equal(started.asyncTask.kind, "agent_task");

    beginBatch(plan, { planId: plan.id, batchId: "first" });
    await writeFile(path.join(repository, "file.txt"), "first\n", "utf8");
    await git(repository, "add", "file.txt");
    await git(repository, "commit", "-qm", "First batch");
    const firstHead = await git(repository, "rev-parse", "HEAD");
    const completed = await completeBatch(plan, {
      planId: plan.id,
      batchId: "first",
      evidence: { summary: "Extracted the first responsibility.", commit: firstHead, checks: { targeted: "passed" } }
    });
    assert.equal(completed.plan.batches[0].status, "completed");
    assert.equal(completed.plan.batches[1].status, "scheduled");
    assert.match(completed.asyncTask.payload.prompt, /Second batch/);

    beginBatch(plan, { planId: plan.id, batchId: "second" });
    await writeFile(path.join(repository, "file.txt"), "second\n", "utf8");
    await git(repository, "add", "file.txt");
    await git(repository, "commit", "-qm", "Second batch");
    const secondHead = await git(repository, "rev-parse", "HEAD");
    const finished = await completeBatch(plan, {
      planId: plan.id,
      batchId: "second",
      evidence: { summary: "Completed the second responsibility.", commit: secondHead, checks: { "full suite": "passed" } }
    });
    assert.equal(finished.plan.status, "completed");
    assert.equal(finished.asyncTask, null);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("refuses completion without required checks or a new commit", async () => {
  const repository = await createRepository();
  try {
    const plan = normalizePlan(input(repository), config, await inspectRepository(repository));
    await approveAndStart(plan);
    beginBatch(plan, { planId: plan.id, batchId: "first" });
    await assert.rejects(
      () => completeBatch(plan, {
        planId: plan.id,
        batchId: "first",
        evidence: { summary: "No verified change", commit: plan.repositoryBaseline, checks: {} }
      }),
      /Missing passing evidence/
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("blocks safely and resumes the same batch", async () => {
  const repository = await createRepository();
  try {
    const plan = normalizePlan(input(repository), config, await inspectRepository(repository));
    await approveAndStart(plan);
    beginBatch(plan, { planId: plan.id, batchId: "first" });
    blockBatch(plan, { planId: plan.id, batchId: "first", reason: "A focused test failed" });
    assert.equal(plan.status, "blocked");
    const resumed = await resumePlan(plan);
    assert.equal(resumed.plan.batches[0].status, "scheduled");
    assert.equal(resumed.plan.batches[0].attempt, 2);
    assert.equal(resumed.plan.batches[1].status, "pending");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("runs a complete plan in a workspace without Git", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "change-plan-no-git-"));
  try {
    const workspaceInfo = await inspectWorkspace(workspace, "disabled");
    const plan = normalizePlan({
      title: "General workspace plan",
      workspace,
      policy: { gitMode: "disabled" },
      batches: [{ id: "one", title: "One batch", objective: "Complete bounded non-Git work.", checks: ["reviewed"] }]
    }, config, workspaceInfo);
    assert.equal(plan.policy.gitEnabled, false);
    assert.equal(plan.policy.requireCommit, false);

    const started = await approveAndStart(plan);
    assert.match(started.asyncTask.payload.prompt, /Git is not required/);
    beginBatch(plan, { planId: plan.id, batchId: "one" });
    const finished = await completeBatch(plan, {
      planId: plan.id,
      batchId: "one",
      evidence: { summary: "Completed without version control.", checks: { reviewed: "passed" } }
    });
    assert.equal(finished.plan.status, "completed");
    assert.equal(finished.plan.batches[0].evidence.commit, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("required Git mode rejects a normal directory without depending on Git availability", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "change-plan-git-required-"));
  try {
    await assert.rejects(() => inspectWorkspace(workspace, "required"), /Git validation is required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("serializes state mutations and leaves valid JSON", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "change-plan-state-"));
  try {
    const store = new ChangePlanStore(stateDir);
    await store.replace({ count: 0 });
    await Promise.all(Array.from({ length: 20 }, () => store.mutate(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { count: state.count + 1 };
    })));
    assert.deepEqual(await store.read(), { count: 20 });
    assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, "active-plan.json"), "utf8")), { count: 20 });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
