import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'node:crypto';
import defaults from './config.js';
import {transact} from './store.js';
import * as m from './model.js';

const NAME = 'git-deploy-watch';
const execute = promisify(execFile);
const core = relative => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, 'src', relative)).href);
const help = `git-deploy-watch v0.1.0
Usage:
  node index.js --help
  node index.js run --request-file <json>

Requires chatId; all configuration, state and tasks are chat-scoped.
Actions (string arguments):
  watch: confirm=true, revision=<full verified deployed SHA>. Starts one recurring checker.
  check: generation=<watch generation>. Internal read-only Git check; only changes queue agent work.
  status: Show authorization, generation, poll task, remote/deployed revision and pending work.
  claim: generation, revision. Required before executing a queued deployment. Returns token and workflow.
  finish: revision, token, outcome=deployed|failed|uncertain, evidence, deployedRevision? (actual built SHA).
  pause: Revoke new claims and stop the poll; cannot recall work already claimed.
  retry: confirm=true. Clear failed/pending work ONLY after manually reconciling any uncertain outcome.

Configure REPO_URL, BRANCH, DOMAIN, WORKFLOW and CHECK_SECONDS before watch.
Only a credential-free HTTPS remote and an exact branch are read. No Git checkout, build,
HTTP deployment or npm publication runs in the checker; the guarded agent executes the
owner-approved workflow after a change. One in-flight deployment at a time. New commits
while it runs coalesce to the newest head on a later check. No reasoning turns on unchanged
polls. Failed revisions are not retried until explicitly reconciled or a different SHA arrives.
Queued/claimed work remains pending after crashes: inspect status before using retry.
Claims older than 30 minutes emit one reconciliation alert; they are never automatically retried.
Configuration changes invalidate queued claims and require pause then watch with approval.
Watch scheduling timeouts remain uncertain; inspect task lists before another watch.
`;

async function remoteHead(c) {
  const {stdout} = await execute('git', ['ls-remote', '--exit-code', '--heads', c.REPO_URL, `refs/heads/${c.BRANCH}`], {
    timeout: 20000, maxBuffer: 65536, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}
  });
  return m.remoteRevision(stdout, c.BRANCH);
}
async function startWatch(state, a, c, client, checkpoint) {
  if (a.confirm !== 'true') throw Error('watch requires explicit owner approval: confirm=true');
  if (state.enabled || state.scheduling === 'uncertain') throw Error('Watcher is active or scheduling is uncertain; inspect status/tasks first');
  const deployed = m.revision(a.revision);
  Object.assign(state, {enabled: true, identity: m.identity(c), generation: crypto.randomUUID(), deployedRevision: deployed, scheduling: 'uncertain'});
  delete state.pending;
  delete state.failedRevision;
  delete state.blocked;
  await checkpoint();
  const task = await client.tasks.add({task: {
    kind: 'poll_tool', runAt: new Date(Date.now() + c.CHECK_SECONDS * 1000).toISOString(),
    payload: {toolName: NAME, args: {action: 'check', generation: state.generation}},
    recurrence: {type: 'interval', everySeconds: c.CHECK_SECONDS}, source: {resourceId: c.DOMAIN}
  }});
  state.taskId = task.id;
  state.scheduling = 'scheduled';
  await checkpoint();
  return {json: {...state, domain: c.DOMAIN, branch: c.BRANCH, everySeconds: c.CHECK_SECONDS}};
}
export async function check(state, a, c, checkpoint, fetcher = remoteHead) {
  if (!state.enabled || a.generation !== state.generation) return {json: {status: 'inactive'}};
  if (state.identity !== m.identity(c)) return {json: {status: 'configuration-changed-reapproval-required'}};
  let sha;
  try { sha = await fetcher(c); }
  catch {
    state.lastCheckedAt = new Date().toISOString();
    const first = !state.lastError;
    state.lastError = 'Remote branch check failed; deployment state was not advanced';
    await checkpoint();
    return {json: {status: 'unverified', error: state.lastError}, ...(first ? {asyncTask: {
      kind: 'agent_event', source: {resourceId: c.DOMAIN}, payload: {prompt: `git-deploy-watch cannot verify ${c.REPO_URL} branch ${c.BRANCH}. No deployment was triggered. Inspect status and report the failure once; do not change the live site.`}
    }} : {})};
  }
  const now = new Date().toISOString();
  const queued = m.queueRevision(state, sha, now);
  const stalled = m.flagStalledClaim(state, now);
  await checkpoint();
  return {json: {status: queued ? 'deployment-queued' : state.pending ? 'deployment-pending' : 'no-change', remoteRevision: sha, deployedRevision: state.deployedRevision},
    ...(queued || stalled ? {asyncTask: {kind: 'agent_event', source: {resourceId: c.DOMAIN}, payload: {prompt: queued ? m.deploymentPrompt(state, c) : m.recoveryPrompt(state, c)}}} : {})};
}
export async function action(request, state, checkpoint, client, c) {
  const a = request.args || {};
  if (request.resourceId && request.resourceId !== c.DOMAIN) throw Error('Exact domain resource binding required');
  if (a.action === 'status') return {json: {...state, domain: c.DOMAIN, branch: c.BRANCH, everySeconds: c.CHECK_SECONDS}};
  if (a.action === 'watch') return startWatch(state, a, c, client, checkpoint);
  if (a.action === 'check') return check(state, a, c, checkpoint);
  if (a.action === 'pause') {
    state.enabled = false;
    await checkpoint();
    if (state.taskId) await client.tasks.cancel({id: state.taskId});
    state.scheduling = 'stopped';
    await checkpoint();
    return {json: {enabled: false, pending: state.pending || null}};
  }
  if (state.identity !== m.identity(c)) throw Error('Configuration changed; pause and reapprove watch');
  if (a.action === 'claim') {
    const claim = m.claim(state, a.generation, a.revision);
    await checkpoint();
    return {json: {...claim, repoUrl: c.REPO_URL, branch: c.BRANCH, domain: c.DOMAIN, workflow: c.WORKFLOW}};
  }
  if (a.action === 'finish') { const result = m.finish(state, a); await checkpoint(); return {json: result}; }
  if (a.action === 'retry') {
    if (a.confirm !== 'true') throw Error('retry requires confirm=true after outcome reconciliation');
    delete state.failedRevision;
    delete state.pending;
    delete state.blocked;
    await checkpoint();
    return {json: {status: 'reconciled', enabled: state.enabled}};
  }
  throw Error('Unknown action; inspect --help');
}
async function run(file) {
  if (!process.env.ARISA_PACKAGE_DIR) throw Error('ARISA_PACKAGE_DIR is required');
  const request = JSON.parse(await readFile(file, 'utf8'));
  if (!request.chatId) throw Error('chatId is required');
  const {loadToolConfig} = await core('core/tools/tool-config.js');
  const {getChatToolStateDir} = await core('runtime/paths.js');
  const {createArisaClient} = await core('core/tools/ipc-client.js');
  const {toolOk, toolNeedsConfig} = await core('core/tools/tool-result.js');
  const config = await loadToolConfig(NAME, defaults, request.chatId);
  const missingConfig = ['REPO_URL', 'DOMAIN', 'WORKFLOW'].filter(key => !config[key]);
  if (missingConfig.length) return toolNeedsConfig({tool: NAME, missingConfig});
  const c = m.validateConfig(config);
  const out = await transact(getChatToolStateDir(request.chatId, NAME), (state, checkpoint) => action(request, state, checkpoint, createArisaClient({toolName: NAME, chatId: request.chatId}), c));
  return toolOk({text: JSON.stringify(out.json, null, 2), json: out.json}, out.asyncTask ? {asyncTask: out.asyncTask} : {});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) console.log(help);
  else if (argv[0] === 'run' && argv.includes('--request-file')) {
    try { console.log(JSON.stringify(await run(argv[argv.indexOf('--request-file') + 1]))); }
    catch (e) { console.log(JSON.stringify({ok: false, status: 'failed', error: e.message})); }
  } else { console.error(help); process.exitCode = 1; }
}
