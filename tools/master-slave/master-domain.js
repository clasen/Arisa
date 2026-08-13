import crypto from "node:crypto";

const OPERATION_CAPABILITIES = Object.freeze({
  "slave.inspect": "inspect",
  "fs.list": "inspect",
  "fs.read": "read",
  "tool.list": "tool.run",
  "tool.run": "tool.run",
  "tool.install": "tool.install",
  "process.exec": "exec",
  "job.cancel": "cancel"
});

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function uniqueIds(values, name) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
  return [...new Set(values.map((value) => requireText(value, name)))];
}

function groupNameKey(name) {
  return requireText(name, "group name").toLocaleLowerCase("en-US");
}

export function createSlaveGroup({ name, description = "", slaveIds = [] }, { groups = [], randomUUID = crypto.randomUUID } = {}) {
  const normalizedName = requireText(name, "group name");
  const duplicate = groups.some((group) => groupNameKey(group.name) === groupNameKey(normalizedName));
  if (duplicate) throw new Error(`Slave group name already exists: ${normalizedName}`);
  return {
    groupId: randomUUID(),
    name: normalizedName,
    description: String(description || "").trim(),
    slaveIds: uniqueIds(slaveIds, "slaveIds")
  };
}

export function addSlavesToGroup(group, slaveIds) {
  return { ...group, slaveIds: [...new Set([...group.slaveIds, ...uniqueIds(slaveIds, "slaveIds")])] };
}

export function removeSlavesFromGroup(group, slaveIds) {
  const removed = new Set(uniqueIds(slaveIds, "slaveIds"));
  return { ...group, slaveIds: group.slaveIds.filter((slaveId) => !removed.has(slaveId)) };
}

export function resolveSlaveTarget(target, { groups = [], slaves = [] } = {}) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("target is required");
  }
  const slaveIds = uniqueIds(target.slaveIds, "target.slaveIds");
  const groupIds = uniqueIds(target.groupIds, "target.groupIds");
  const groupsById = new Map(groups.map((group) => [group.groupId, group]));
  const slavesById = new Map(slaves.map((slave) => [slave.slaveId, slave]));
  const missingGroupIds = groupIds.filter((groupId) => !groupsById.has(groupId));
  if (missingGroupIds.length) {
    const error = new Error(`Unknown slave groups: ${missingGroupIds.join(", ")}`);
    error.code = "GROUP_NOT_FOUND";
    error.groupIds = missingGroupIds;
    throw error;
  }
  const resolvedIds = new Set(slaveIds);
  for (const groupId of groupIds) {
    for (const slaveId of groupsById.get(groupId).slaveIds) resolvedIds.add(slaveId);
  }
  const missingSlaveIds = [...resolvedIds].filter((slaveId) => !slavesById.has(slaveId));
  if (missingSlaveIds.length) {
    const error = new Error(`Unknown slaves: ${missingSlaveIds.join(", ")}`);
    error.code = "SLAVE_NOT_FOUND";
    error.slaveIds = missingSlaveIds;
    throw error;
  }
  if (!resolvedIds.size) throw new Error("target must select at least one Slave");
  return Object.freeze({
    slaveIds: Object.freeze([...resolvedIds]),
    groupIds: Object.freeze([...groupIds])
  });
}

function hasChatGrant(slave, chatId) {
  return Array.isArray(slave.authorizedChatIds)
    && slave.authorizedChatIds.some((authorized) => String(authorized) === String(chatId));
}

function hasCapability(slave, capability) {
  return Array.isArray(slave.profile?.capabilities) && slave.profile.capabilities.includes(capability);
}

export function preflightSlaveBatch({
  target,
  operation,
  requestedByChatId,
  allowPartial = false
}, { groups = [], slaves = [] } = {}) {
  const capability = OPERATION_CAPABILITIES[operation];
  if (!capability) throw new Error(`Unsupported Slave operation: ${operation}`);
  const snapshot = resolveSlaveTarget(target, { groups, slaves });
  const slavesById = new Map(slaves.map((slave) => [slave.slaveId, slave]));
  const accepted = [];
  const rejected = [];

  for (const slaveId of snapshot.slaveIds) {
    const slave = slavesById.get(slaveId);
    let code = null;
    if (!hasChatGrant(slave, requestedByChatId)) code = "not_authorized";
    else if (!hasCapability(slave, capability)) code = "capability_missing";
    else if (slave.connectionState !== "connected") code = "slave_offline";
    if (code) rejected.push({ slaveId, name: slave.profile?.name || slaveId, code });
    else accepted.push(slave);
  }

  if (rejected.length && !allowPartial) {
    const error = new Error(`Slave batch preflight failed: ${rejected.map((item) => `${item.slaveId}:${item.code}`).join(", ")}`);
    error.code = "PREFLIGHT_FAILED";
    error.rejected = rejected;
    error.snapshot = snapshot;
    throw error;
  }
  if (!accepted.length) {
    const error = new Error("Slave batch preflight selected no runnable Slaves");
    error.code = "NO_RUNNABLE_SLAVES";
    error.rejected = rejected;
    throw error;
  }
  return {
    snapshot,
    capability,
    slaves: accepted,
    rejected,
    partial: rejected.length > 0
  };
}

export function createBatch(preflight, { operation, args = {}, requestedByChatId, now = () => new Date(), randomUUID = crypto.randomUUID } = {}) {
  const batchId = randomUUID();
  const createdAtDate = now();
  const createdAt = createdAtDate.toISOString();
  const ttlMs = Number(args.jobTtlMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("jobTtlMs must be a positive integer");
  const operationArgs = { ...args };
  delete operationArgs.jobTtlMs;
  const expiresAt = new Date(createdAtDate.getTime() + ttlMs).toISOString();
  const jobs = preflight.slaves.map((slave) => ({
    jobId: randomUUID(),
    batchId,
    slaveId: slave.slaveId,
    slaveName: slave.profile?.name || slave.slaveId,
    operation,
    args: operationArgs,
    requestedByChatId: String(requestedByChatId),
    issuedAt: createdAt,
    expiresAt,
    scope: preflight.capability,
    status: "queued"
  }));
  return {
    batchId,
    operation,
    requestedByChatId: String(requestedByChatId),
    targetSnapshot: preflight.snapshot,
    rejected: preflight.rejected,
    createdAt,
    status: "queued",
    jobs
  };
}

export function summarizeBatch(batch) {
  const counts = { completed: 0, failed: 0, cancelled: 0, expired: 0, not_started: 0, pending: 0 };
  for (const job of batch.jobs) {
    if (Object.hasOwn(counts, job.status)) counts[job.status] += 1;
    else counts.pending += 1;
  }
  counts.notStarted = counts.not_started + counts.pending;
  delete counts.not_started;
  delete counts.pending;
  return { batchId: batch.batchId, ...counts, total: batch.jobs.length };
}
