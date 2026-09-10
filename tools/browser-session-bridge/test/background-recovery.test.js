import assert from "node:assert/strict";
import test from "node:test";

test("worker arms recovery before reading pending operations", async () => {
  const previous = globalThis.chrome;
  const events = [];
  let startup;
  const listener = { addListener() {} };
  globalThis.chrome = {
    runtime: { onStartup: { addListener(fn) { startup = fn; } }, onInstalled: listener, onMessage: listener },
    permissions: { onAdded: listener },
    alarms: {
      onAlarm: listener,
      get: async () => undefined,
      create: async () => { events.push("alarm"); },
      clear: async () => { events.push("clear"); }
    },
    storage: {
      onChanged: listener,
      local: { get: async () => { events.push("storage"); return {}; } }
    }
  };
  try {
    await import(`../extension/background.js?test=${Date.now()}`);
    startup();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events[0], "alarm");
    assert.ok(events.includes("storage"));
    assert.equal(events.at(-1), "clear");
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
