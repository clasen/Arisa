export function taskWithoutCallerRouting(task = {}) {
  const { route: _route, ...safeTask } = task;
  const payload = { ...(safeTask.payload || {}) };
  delete payload.chatId;
  delete payload.telegramContext;
  return { ...safeTask, payload };
}
