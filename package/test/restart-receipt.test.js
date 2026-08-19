import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancelRestartReceipt, deliverRestartReceipt, prepareRestartReceipt } from "../src/runtime/restart-receipt.js";

const identity = async () => ({ version: "5.1.30", commit: "abc123" });

test("restart receipt returns to the originating Telegram topic exactly once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-receipt-"));
  const receiptFile = path.join(directory, "receipt.json");
  try {
    await prepareRestartReceipt({ transportChatId: -1001, threadId: 23 }, { reason: "test" }, { receiptFile, getIdentity: identity });
    const sent = [];
    const result = await deliverRestartReceipt((...args) => sent.push(args), { receiptFile, getIdentity: identity });
    assert.equal(result.verified, true);
    assert.deepEqual(sent[0].slice(0, 1), [-1001]);
    assert.equal(sent[0][2].message_thread_id, 23);
    assert.match(sent[0][1], /Arisa 5\.1\.30 is running/);
    assert.match(sent[0][1], /Commit: abc123/);
    assert.equal(await deliverRestartReceipt(() => {}, { receiptFile, getIdentity: identity }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed handoff can cancel only its own restart receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-cancel-"));
  const receiptFile = path.join(directory, "receipt.json");
  try {
    const receipt = await prepareRestartReceipt({ transportChatId: 42 }, {}, { receiptFile, getIdentity: identity });
    assert.equal(await cancelRestartReceipt("another-id", { receiptFile }), false);
    assert.equal(await cancelRestartReceipt(receipt.id, { receiptFile }), true);
    await assert.rejects(access(receiptFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
