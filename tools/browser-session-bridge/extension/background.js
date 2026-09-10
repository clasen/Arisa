import { createWorkflow, SETUP, SEND } from "./background-workflow.js";

const workflow = createWorkflow(chrome);
const RECOVERY_ALARM = "arisa-operation-recovery";

async function recover() {
  // Arm recovery before network work: the worker may stop during a request.
  if (!await chrome.alarms.get(RECOVERY_ALARM)) await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
  try {
    await workflow.resume();
  } finally {
    const stored = await chrome.storage.local.get([SETUP, SEND]);
    if (stored[SETUP] || stored[SEND]) {
      if (!await chrome.alarms.get(RECOVERY_ALARM)) await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
    } else {
      await chrome.alarms.clear(RECOVERY_ALARM);
    }
  }
}

const wake = () => { recover().catch(() => {}); };
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);
chrome.permissions.onAdded.addListener(wake);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RECOVERY_ALARM) wake(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[SETUP]?.newValue || changes[SEND]?.newValue)) wake();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const operation = message?.action === "resume" ? recover
    : message?.action === "forget" ? workflow.forget
    : message?.action === "cancel-send" ? workflow.cancelSend : null;
  if (!operation) return false;
  operation().then(() => respond({ ok: true }), () => respond({ ok: false, error: "Background operation failed. Reopen the extension to check its state." }));
  return true;
});
