import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceCodeTelegramMessage } from "../src/transport/telegram/device-code-message.js";

test("builds a copyable device-code Telegram message with HTML and inline buttons", () => {
  const payload = buildDeviceCodeTelegramMessage({
    userCode: "TR2S-K4GBZ",
    verificationUri: "https://auth.openai.com/codex/device",
    expiresInSeconds: 900
  });

  assert.equal(payload.parse_mode, "HTML");
  assert.match(payload.text, /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(payload.text, /<code>TR2S-K4GBZ<\/code>/);
  assert.match(payload.text, /Expires in 15 minute\(s\)\./);
  assert.deepEqual(payload.reply_markup.inline_keyboard, [[
    { text: "Copy code: TR2S-K4GBZ", copy_text: { text: "TR2S-K4GBZ" } },
    { text: "Open login page", url: "https://auth.openai.com/codex/device" }
  ]]);
  assert.deepEqual(payload.link_preview_options, { is_disabled: true });
});

test("escapes HTML-sensitive device-code values", () => {
  const payload = buildDeviceCodeTelegramMessage({
    userCode: "A&B<1>",
    verificationUri: "https://example.com/?q=\"x\""
  });

  assert.match(payload.text, /<code>A&amp;B&lt;1&gt;<\/code>/);
  assert.match(payload.text, /href="https:\/\/example\.com\/\?q=&quot;x&quot;"/);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].copy_text.text, "A&B<1>");
});

test("omits copy button when code exceeds Telegram copy_text limit", () => {
  const payload = buildDeviceCodeTelegramMessage({
    userCode: "x".repeat(257),
    verificationUri: "https://example.com/device"
  });

  assert.equal(payload.reply_markup.inline_keyboard[0].length, 1);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text, "Open login page");
});
