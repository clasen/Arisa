import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";
import { SlaveBatchRunner } from "./batch-runner.js";
import { ChatMasterSlaveStore } from "./chat-state-store.js";
import {
  addSlavesToGroup,
  createBatch,
  createSlaveGroup,
  preflightSlaveBatch,
  removeSlavesFromGroup
} from "./master-domain.js";
import {
  bootstrapSlaveConnection,
  createPairingStore,
  createRuntimeIdentity,
  MasterNetworkRuntime,
  notifySlavePairing,
  resolveSlavePolicy,
  runtimeIdentityDiagnostic,
  SlaveNetworkRuntime
} from "./remote-runtime.js";
import { MasterSlaveStateStore } from "./state-store.js";

const toolName = "master-slave";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { createArisaClient } = await importCore("core/tools/ipc-client.js");
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolNeedsConfig, toolOk } = await importCore("core/tools/tool-result.js");
const { readDaemonDiagnostic } = await importCore("core/tools/daemon-processes.js");
const { getChatToolStateDir, getToolStateDir } = await importCore("runtime/paths.js");

const state = new MasterSlaveStateStore(getToolStateDir(toolName));
const daemon = createDaemonRuntime({
  toolName,
  entryPath: fileURLToPath(import.meta.url),
  autoStart: true
});
let activeNetwork = null;
let activeConfig = null;
let activeIdentity = null;
const activeBatches = new Map();
const offlineTimers = new Map();

function printHelp() {
  console.log(`master-slave

Usage:
  node index.js --help
  node index.js run --request-file <json>
  node index.js daemon

Actions:
  create_slave_bootstrap, list_slaves, inspect_slave
  create_slave_group, list_slave_groups, add_slaves_to_group
  remove_slaves_from_group, delete_slave_group
  list_slave_tools, run_slave_tool, read_slave_file, run_slave_command
  install_slave_tool, cancel_slave_batch, revoke_slave
  configure_slave
  slave.bootstrap, slave.status, slave.unpair
`);
}

function missingMasterConfig(config) {
  return [
    config.role !== "master" && "role",
    !config.listenHost && "listenHost",
    !config.listenPort && "listenPort",
    !config.publicEndpoint && "publicEndpoint"
  ].filter(Boolean);
}

async function resolveRole(config) {
  const stored = await state.readRole();
  return stored?.role || config.role || "";
}

function arisaClient(chatId = null) {
  return createArisaClient({ toolName, chatId });
}

function chatStore(chatId) {
  if (chatId == null || chatId === "") throw new Error("master-slave operation requires chatId");
  return new ChatMasterSlaveStore(getChatToolStateDir(chatId, toolName));
}

async function publicPeer(peer) {
  const { identityPublicKey, ...safe } = peer;
  return safe;
}

async function peersForChat(chatId) {
  const peers = await state.listPeers();
  return Promise.all(peers
    .filter((peer) => peer.authorizedChatIds?.some((value) => String(value) === String(chatId)))
    .map(publicPeer));
}

async function requirePeer(chatId, slaveId) {
  const peer = await state.getPeer(String(slaveId || ""));
  if (!peer) throw Object.assign(new Error(`Slave not found: ${slaveId}`), { code: "SLAVE_NOT_FOUND" });
  if (!peer.authorizedChatIds?.some((value) => String(value) === String(chatId))) {
    throw Object.assign(new Error("Chat is not authorized for this Slave"), { code: "NOT_AUTHORIZED" });
  }
  return peer;
}

function actionOperation(action, args) {
  if (action === "inspect_slave") return { operation: "slave.inspect", remoteArgs: {} };
  if (action === "list_slave_tools") return { operation: "tool.list", remoteArgs: {} };
  if (action === "read_slave_file") return { operation: "fs.read", remoteArgs: { path: args.path } };
  if (action === "run_slave_tool") return { operation: "tool.run", remoteArgs: { tool: args.tool, args: args.args || {}, timeoutMs: args.timeoutMs } };
  if (action === "install_slave_tool") return {
    operation: "tool.install",
    remoteArgs: {
      tool: args.tool,
      confirmToolName: args.confirmToolName,
      confirmRoot: args.confirmRoot
    }
  };
  if (action === "run_slave_command") return {
    operation: "process.exec",
    remoteArgs: {
      executable: args.executable,
      argv: args.argv || [],
      cwd: args.cwd,
      timeoutMs: args.timeoutMs
    }
  };
  return null;
}

async function runRemoteBatch(request, context) {
  const args = request.args || {};
  const mapped = actionOperation(args.action, args);
  if (!mapped) throw new Error(`Unsupported remote action: ${args.action}`);
  const groups = await chatStore(request.chatId).listGroups();
  const slaves = await state.listPeers();
  const target = args.target || { slaveIds: [String(args.slaveId || "")], groupIds: [] };
  const preflight = preflightSlaveBatch({
    target,
    operation: mapped.operation,
    requestedByChatId: request.chatId,
    allowPartial: args.allowPartial === true
  }, { groups, slaves });
  if (args.action === "install_slave_tool") {
    if (args.confirmToolName !== args.tool) {
      throw new Error("install_slave_tool requires confirmToolName equal to the requested tool");
    }
    const expected = preflight.accepted.map((slave) => slave.slaveId).sort();
    const confirmed = [...new Set(args.confirmSlaveIds || [])].map(String).sort();
    if (expected.length !== confirmed.length || expected.some((slaveId, index) => slaveId !== confirmed[index])) {
      throw new Error("install_slave_tool requires confirmSlaveIds to match the resolved Slave snapshot");
    }
  }
  const batch = createBatch(preflight, {
    operation: mapped.operation,
    args: { ...mapped.remoteArgs, jobTtlMs: activeConfig.jobTtlMs },
    requestedByChatId: request.chatId
  });
  const store = chatStore(request.chatId);
  const runner = new SlaveBatchRunner({
    concurrency: activeConfig.batchConcurrency,
    persistBatch: (value) => store.saveBatch(value),
    onEvent: (event) => context.emit("chunk", event),
    executeJob: (job, { onChunk, signal }) => {
      const remoteJob = activeNetwork.run(job, { onEvent: (event) => {
        if (event.status === "chunk") return onChunk(event.chunk);
      } });
      if (!signal) return remoteJob;
      return new Promise((resolve, reject) => {
        const abort = () => {
          activeNetwork.cancel(job.slaveId, job.jobId).catch(() => {});
          reject(Object.assign(new Error(`Remote job cancelled: ${job.jobId}`), { code: "JOB_CANCELLED" }));
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        remoteJob.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    }
  });
  activeBatches.set(batch.batchId, runner);
  try {
    const completed = await runner.run(batch);
    if (completed.jobs.length !== 1 || completed.jobs[0].status !== "completed") return completed;
    const result = completed.jobs[0].result;
    const remoteArtifact = result?.output?.remoteArtifact || result?.remoteArtifact || (result?.contentBase64 ? {
      contentBase64: result.contentBase64,
      fileName: path.basename(result.path || "remote-file.bin"),
      mimeType: "application/octet-stream",
      kind: "file"
    } : null);
    if (!remoteArtifact) return completed;
    const tmpDir = await arisaClient(request.chatId).paths.getChatToolTmpDir();
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const fileName = path.basename(String(remoteArtifact.fileName || "remote-file.bin"));
    const filePath = path.join(tmpDir, `${crypto.randomUUID()}-${fileName}`);
    const content = Buffer.from(remoteArtifact.contentBase64, "base64");
    if (content.length > activeConfig.maxJobOutputBytes) throw new Error("Remote artifact exceeds the job output limit");
    await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
    return {
      __toolOutput: {
        filePath,
        fileName,
        mimeType: remoteArtifact.mimeType,
        kind: remoteArtifact.kind,
        delivery: remoteArtifact.delivery,
        json: completed
      }
    };
  } finally {
    activeBatches.delete(batch.batchId);
  }
}

async function handleGroups(request) {
  const args = request.args || {};
  const store = chatStore(request.chatId);
  const groups = await store.listGroups();
  if (args.action === "list_slave_groups") return groups;
  if (args.action === "create_slave_group") {
    const group = createSlaveGroup(args, { groups });
    await store.saveGroups([...groups, group]);
    return group;
  }
  const index = groups.findIndex((group) => group.groupId === args.groupId);
  if (index === -1) throw new Error(`Slave group not found: ${args.groupId}`);
  if (args.action === "delete_slave_group") {
    await store.saveGroups(groups.filter((_, groupIndex) => groupIndex !== index));
    return { deleted: true, groupId: args.groupId };
  }
  const updated = args.action === "add_slaves_to_group"
    ? addSlavesToGroup(groups[index], args.slaveIds)
    : removeSlavesFromGroup(groups[index], args.slaveIds);
  await store.saveGroups(groups.map((group, groupIndex) => groupIndex === index ? updated : group));
  return updated;
}

async function masterAction(request, context) {
  const args = request.args || {};
  if (args.action === "create_slave_bootstrap") {
    return activeNetwork.createBootstrap(request.chatId);
  }
  if (args.action === "list_slaves") return peersForChat(request.chatId);
  if (args.action === "revoke_slave") {
    await requirePeer(request.chatId, args.slaveId);
    return activeNetwork.revoke(args.slaveId);
  }
  if (args.action === "configure_slave") {
    const peer = await requirePeer(request.chatId, args.slaveId);
    if (args.confirmSlaveId !== peer.slaveId) {
      throw new Error("configure_slave requires confirmSlaveId equal to the selected Slave id");
    }
    const now = new Date();
    const job = {
      jobId: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      slaveId: peer.slaveId,
      operation: "slave.configure",
      args: {
        name: args.name,
        description: args.description,
        roots: args.roots,
        capabilities: args.capabilities,
        fullHost: args.fullHost === true,
        confirmRoot: args.confirmRoot
      },
      requestedByChatId: String(request.chatId),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + activeConfig.jobTtlMs).toISOString(),
      scope: "configure"
    };
    const policy = await activeNetwork.run(job);
    await state.savePeer({
      ...peer,
      profile: {
        ...peer.profile,
        name: policy.name || peer.profile?.name,
        description: policy.description,
        roots: policy.roots,
        capabilities: policy.capabilities,
        privilege: {
          ...peer.profile?.privilege,
          scope: policy.fullHost ? "full-host" : "restricted"
        }
      }
    });
    return { slaveId: peer.slaveId, policy };
  }
  if (["create_slave_group", "list_slave_groups", "add_slaves_to_group", "remove_slaves_from_group", "delete_slave_group"].includes(args.action)) {
    return handleGroups(request);
  }
  if (args.action === "cancel_slave_batch") {
    const runner = activeBatches.get(args.batchId);
    return { batchId: args.batchId, cancelRequested: runner?.cancel(args.batchId) || false };
  }
  return runRemoteBatch(request, context);
}

async function diagnostic() {
  const config = activeConfig || await loadToolConfig(toolName, defaults);
  const role = await resolveRole(config);
  const slave = await state.readSlave();
  const jobs = await state.listJobs();
  const pendingSecrets = role === "master" ? (await createPairingStore(state, config).list()).length : 0;
  const terminal = new Set(["completed", "failed", "cancelled", "expired"]);
  return {
    daemon: await readDaemonDiagnostic({ toolName, scope: { type: "global" }, autoStart: true }),
    role,
    endpoint: role === "master" ? config.publicEndpoint : slave?.endpoint || null,
    identityFingerprint: activeIdentity ? runtimeIdentityDiagnostic(activeIdentity) : null,
    paired: role === "slave" ? Boolean(slave?.paired) : null,
    toolCount: (await arisaClient().tools.list().catch(() => [])).length,
    jobs: {
      active: jobs.filter((job) => job.status === "accepted").length,
      queued: jobs.filter((job) => job.status === "queued").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      terminal: jobs.filter((job) => terminal.has(job.status)).length
    },
    pendingSecrets
  };
}

async function processRequest(request, context = { emit: async () => {} }) {
  const action = request.args?.action;
  if (action === "slave.status" || action === "master.status") return toolOk({ json: await diagnostic() });
  if (action === "slave.unpair") {
    activeNetwork?.stop?.();
    return toolOk({ json: await state.unpairSlave() });
  }
  const config = activeConfig || await loadToolConfig(toolName, defaults);
  const role = await resolveRole(config);
  if (role !== "master") throw new Error(`Action ${action} requires the Master role`);
  const result = await masterAction(request, context);
  return result?.__toolOutput ? toolOk(result.__toolOutput) : toolOk({ json: result });
}

async function runDirectBootstrap(request) {
  const bootstrapFile = request.args?.bootstrapFile;
  if (!bootstrapFile) throw new Error("slave.bootstrap requires bootstrapFile");
  const bootstrap = JSON.parse(await readFile(bootstrapFile, "utf8"));
  const config = await loadToolConfig(toolName, defaults);
  const identity = await createRuntimeIdentity(state);
  const root = process.geteuid?.() === 0;
  const policy = resolveSlavePolicy({ config, root });
  const profile = {
    slaveId: "",
    name: os.hostname(),
    description: "",
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    arisaVersion: "unknown",
    masterEndpoint: "",
    privilege: {
      user: os.userInfo().username,
      root,
      scope: policy.fullHost ? "full-host" : "restricted"
    },
    roots: policy.roots,
    capabilities: policy.capabilities,
    tools: []
  };
  const result = await bootstrapSlaveConnection({
    url: bootstrap.url,
    state,
    identity,
    profile,
    maxFrameBytes: config.maxFrameBytes
  });
  result.connection.close();
  return toolOk({ json: { paired: true, slaveId: result.slaveId, endpoint: result.endpoint } });
}

async function runCli(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const result = request.args?.action === "slave.bootstrap"
    ? await runDirectBootstrap(request)
    : await daemon.submit(request);
  console.log(JSON.stringify(result));
}

async function startNetwork(config, role) {
  activeIdentity = await createRuntimeIdentity(state);
  if (role === "master") {
    const missing = missingMasterConfig(config);
    if (missing.length) throw Object.assign(new Error(`Missing Master configuration: ${missing.join(", ")}`), { code: "MISSING_CONFIG" });
    activeNetwork = new MasterNetworkRuntime({
      config,
      state,
      identity: activeIdentity,
      pairingStore: createPairingStore(state, config),
      onConnectionEvent: async ({ type, peer, paired }) => {
        const current = offlineTimers.get(peer.slaveId);
        if (current) clearTimeout(current);
        offlineTimers.delete(peer.slaveId);
        if (await notifySlavePairing({ type, peer, paired }, arisaClient)) return;
        if (type !== "disconnected") return;
        const timer = setTimeout(async () => {
          offlineTimers.delete(peer.slaveId);
          const latest = await state.getPeer(peer.slaveId);
          if (latest?.connectionState !== "offline" || latest.offlineNoticeAt) return;
          const offlineNoticeAt = new Date().toISOString();
          await state.savePeer({ ...latest, offlineNoticeAt });
          for (const chatId of latest.authorizedChatIds || []) {
            await arisaClient(chatId).agent.enqueueEvent({
              resourceId: peer.slaveId,
              prompt: `Arisa Slave ${latest.profile?.name || peer.slaveId} has remained offline for more than ${config.offlineWarningMs}ms. Master cannot distinguish whether the service is stopped, the network is unavailable, or the configured endpoint is wrong. Check the Slave service and network.`
            }).catch(() => {});
          }
        }, config.offlineWarningMs);
        timer.unref?.();
        offlineTimers.set(peer.slaveId, timer);
      }
    });
    await activeNetwork.start();
    return;
  }
  if (role === "slave") {
    activeNetwork = new SlaveNetworkRuntime({
      config,
      state,
      identity: activeIdentity,
      arisa: (chatId) => arisaClient(chatId),
      arisaVersion: "unknown"
    });
    activeNetwork.start().catch(() => {});
    return;
  }
  throw Object.assign(new Error("master-slave role is not configured"), { code: "MISSING_CONFIG" });
}

async function runDaemon() {
  activeConfig = await loadToolConfig(toolName, defaults);
  const role = await resolveRole(activeConfig);
  await startNetwork(activeConfig, role);
  await daemon.workLoop({
    healthCheck: async () => {
      if (role === "master" && !activeNetwork.server?.listening) throw new Error("Master TCP listener is not active");
      if (role === "slave" && !(await state.readSlave())?.paired) throw new Error("Slave is not paired");
      return { message: `${role} network runtime is healthy` };
    },
    recover: async () => {
      await activeNetwork?.stop?.();
      await startNetwork(activeConfig, role);
      return true;
    },
    beforeExit: () => activeNetwork?.stop?.(),
    processJob: processRequest
  });
}

const args = process.argv.slice(2);
try {
  if (args[0] === "daemon") await runDaemon();
  else if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
  else if (args[0] === "run") await runCli(args[args.indexOf("--request-file") + 1]);
  else printHelp();
} catch (error) {
  const config = await loadToolConfig(toolName, defaults).catch(() => defaults);
  const missing = error?.code === "MISSING_CONFIG" ? missingMasterConfig(config) : [];
  console.log(JSON.stringify(missing.length
    ? toolNeedsConfig({ tool: toolName, missingConfig: missing, message: error.message })
    : toolError(error?.message || String(error), { code: error?.code || null })));
  if (args[0] === "daemon") process.exitCode = 1;
}
