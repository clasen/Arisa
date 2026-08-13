import assert from "node:assert/strict";
import test from "node:test";
import {
  addSlavesToGroup,
  createBatch,
  createSlaveGroup,
  preflightSlaveBatch,
  removeSlavesFromGroup,
  resolveSlaveTarget,
  summarizeBatch
} from "../master-domain.js";

const slaves = [
  {
    slaveId: "slave-a",
    connectionState: "connected",
    authorizedChatIds: ["10"],
    profile: { name: "api-a", capabilities: ["inspect", "read", "tool.run", "exec"] }
  },
  {
    slaveId: "slave-b",
    connectionState: "connected",
    authorizedChatIds: ["20"],
    profile: { name: "api-b", capabilities: ["inspect", "read"] }
  },
  {
    slaveId: "slave-c",
    connectionState: "offline",
    authorizedChatIds: ["10"],
    profile: { name: "api-c", capabilities: ["inspect", "read"] }
  }
];

const groups = [
  { groupId: "production", name: "production", description: "", slaveIds: ["slave-a", "slave-b"] },
  { groupId: "readers", name: "readers", description: "", slaveIds: ["slave-a", "slave-c"] }
];

test("keeps group names unique and membership many-to-many", () => {
  const group = createSlaveGroup(
    { name: "Workers", slaveIds: ["slave-a", "slave-a"] },
    { groups, randomUUID: () => "workers-id" }
  );
  assert.deepEqual(group.slaveIds, ["slave-a"]);
  assert.deepEqual(addSlavesToGroup(group, ["slave-b", "slave-a"]).slaveIds, ["slave-a", "slave-b"]);
  assert.deepEqual(removeSlavesFromGroup({ ...group, slaveIds: ["slave-a", "slave-b"] }, ["slave-a"]).slaveIds, ["slave-b"]);
  assert.throws(() => createSlaveGroup({ name: "PRODUCTION" }, { groups }), /already exists/);
});

test("resolves a deduplicated immutable target snapshot", () => {
  const snapshot = resolveSlaveTarget(
    { slaveIds: ["slave-a"], groupIds: ["production", "readers"] },
    { groups, slaves }
  );
  assert.deepEqual(snapshot.slaveIds, ["slave-a", "slave-b", "slave-c"]);
  assert.throws(() => snapshot.slaveIds.push("slave-d"), TypeError);
});

test("group membership never grants access and safe preflight starts no jobs", () => {
  assert.throws(
    () => preflightSlaveBatch({
      target: { groupIds: ["production"] },
      operation: "fs.read",
      requestedByChatId: "10"
    }, { groups, slaves }),
    (error) => error.code === "PREFLIGHT_FAILED"
      && error.rejected[0].slaveId === "slave-b"
      && error.rejected[0].code === "not_authorized"
  );
});

test("partial mode is explicit and still reports rejected Slaves", () => {
  const preflight = preflightSlaveBatch({
    target: { groupIds: ["readers"] },
    operation: "fs.read",
    requestedByChatId: "10",
    allowPartial: true
  }, { groups, slaves });
  assert.deepEqual(preflight.slaves.map((slave) => slave.slaveId), ["slave-a"]);
  assert.deepEqual(preflight.rejected, [{ slaveId: "slave-c", name: "api-c", code: "slave_offline" }]);
});

test("creates one durable job per Slave from the accepted snapshot", () => {
  const preflight = preflightSlaveBatch({
    target: { slaveIds: ["slave-a"] },
    operation: "process.exec",
    requestedByChatId: "10"
  }, { groups, slaves });
  const ids = ["batch", "job-a"];
  const batch = createBatch(preflight, {
    operation: "process.exec",
    args: { executable: "node", argv: ["--version"], jobTtlMs: 60_000 },
    requestedByChatId: "10",
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    randomUUID: () => ids.shift()
  });
  assert.equal(batch.batchId, "batch");
  assert.equal(batch.jobs[0].jobId, "job-a");
  assert.deepEqual(summarizeBatch({ ...batch, jobs: [{ ...batch.jobs[0], status: "completed" }] }), {
    batchId: "batch",
    completed: 1,
    failed: 0,
    cancelled: 0,
    expired: 0,
    notStarted: 0,
    total: 1
  });
});
