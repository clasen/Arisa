import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function incomingBridge({ tasks = [], gate = {}, addError = null } = {}) {
  const added = [];
  const context = vm.createContext({
    crypto,
    process: { pid: 1 },
    toolName: 'whatsapp-web',
    createArisaClient({ chatId }) {
      assert.equal(String(chatId), '123');
      return { tasks: {
        list: async () => tasks,
        add: async ({ task }) => {
          if (addError) throw addError;
          added.push(task);
          tasks.push(task);
          return task;
        }
      } };
    },
    classifyWakeGate: async () => gate,
    writeChatStatus: async () => {},
    buildIncomingBurstPrompt: items => items.map(item => item.message.body).join('\n')
  });
  for (const [start, end] of [
    ['async function readTasks(', 'function isTechnicalWhatsAppNotification('],
    ['function taskContainsIncomingMessage(', 'function serializedWhatsAppId('],
    ['function incomingMessageTask(', 'function renderQr(']
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return { context, added };
}

const items = [{ message: { id: 'm1', from: 'sender@lid', body: 'hello' }, artifact: { id: 'a1' } }];

test('incoming messages enter the live queue as scoped events and deduplicate', async () => {
  const { context, added } = incomingBridge();
  await context.enqueueArisaTaskForIncomingBurst('123', items);
  await context.enqueueArisaTaskForIncomingBurst(123, items);
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'agent_event');
  assert.equal(added[0].payload.chatId, 123);
  assert.equal(added[0].payload.artifactId, 'a1');
  assert.equal(added[0].source.resourceId, 'sender@lid');
  assert.equal(added[0].source.messageIds[0], 'm1');
});

test('deduplication accepts persisted string chat ids', async () => {
  const { context, added } = incomingBridge({ tasks: [{ source: { toolName: 'whatsapp-web', chatId: '123', messageIds: ['m1'] } }] });
  await context.enqueueArisaTaskForIncomingBurst(123, items);
  assert.equal(added.length, 0);
});

test('enforced passive gate does not enqueue; shadow does', async () => {
  const enforced = incomingBridge({ gate: { enabled: true, mode: 'enforce', wake: false } });
  assert.equal((await enforced.context.enqueueArisaTaskForIncomingBurst(123, items)).suppressed, true);
  assert.equal(enforced.added.length, 0);
  const shadow = incomingBridge({ gate: { enabled: true, mode: 'shadow', wake: false } });
  await shadow.context.enqueueArisaTaskForIncomingBurst(123, items);
  assert.equal(shadow.added.length, 1);
});

test('IPC failure propagates instead of claiming queue success', async () => {
  const { context, added } = incomingBridge({ addError: new Error('IPC unavailable') });
  await assert.rejects(context.enqueueArisaTaskForIncomingBurst(123, items), /IPC unavailable/);
  assert.equal(added.length, 0);
});

test('login-ready notification also uses the live event queue', async () => {
  const { context, added } = incomingBridge();
  await context.enqueueWhatsAppReadyTask('123');
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'agent_event');
  assert.equal(added[0].source.event, 'login_ready');
});

test('task bridge uses chat-scoped IPC and preserves task metadata', async () => {
  const calls = [];
  const task = { source: { resourceId: 'test@lid', messageIds: ['message-1'] } };
  const context = vm.createContext({
    toolName: 'whatsapp-web',
    createArisaClient(identity) {
      return { tasks: {
        list: async params => { calls.push({ identity, params }); return [task]; },
        add: async params => { calls.push({ identity, params }); return params.task; }
      } };
    }
  });
  const bridge = source.slice(source.indexOf('async function readTasks('), source.indexOf('function isTechnicalWhatsAppNotification('));
  vm.runInContext(bridge, context);
  assert.equal((await context.readTasks('123'))[0], task);
  assert.equal(await context.addTask('123', task), task);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.identity.chatId === '123' && call.identity.toolName === 'whatsapp-web'));
  assert.equal(calls[1].params.task, task);
});

test('WhatsApp does not read or overwrite the obsolete task JSON queue', () => {
  assert.doesNotMatch(source, /\btasksFile\b|\bwriteTasks\b/);
  assert.match(source, /await readTasks\(numericChatId\)/);
  assert.equal((source.match(/await addTask\(numericChatId,/g) || []).length, 2);
});
