import assert from "node:assert/strict";
import test from "node:test";
import { renderTelegramHtml, splitTelegramText } from "../src/transport/telegram/text-format.js";

test("escapes HTML-sensitive characters in inline text", () => {
  const rendered = renderTelegramHtml("<script>alert(\"x\")</script> & done");

  assert.equal(rendered, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; done");
});

test("escapes inline formatting content before rendering Telegram HTML tags", () => {
  const rendered = renderTelegramHtml("**<b>bold & safe</b>** and `<tag attr=\"x\">`");

  assert.equal(
    rendered,
    "<b>&lt;b&gt;bold &amp; safe&lt;/b&gt;</b> and <code>&lt;tag attr=&quot;x&quot;&gt;</code>"
  );
});

test("escapes fenced code content", () => {
  const rendered = renderTelegramHtml("before\n```js\nconst x = \"<tag>\" && value;\n```\nafter");

  assert.equal(
    rendered,
    "before\n<pre><code language=\"js\">const x = &quot;&lt;tag&gt;&quot; &amp;&amp; value;</code></pre>\nafter"
  );
});

test("escapes fenced code language attributes", () => {
  const rendered = renderTelegramHtml("```js\" onmouseover=\"alert(1)\nconsole.log(\"safe\");\n```");

  assert.match(rendered, /<pre><code language="js&quot; onmouseover=&quot;alert\(1\)">/);
  assert.doesNotMatch(rendered, /onmouseover="/);
});

test("leaves unterminated fences as escaped inline text", () => {
  const rendered = renderTelegramHtml("```html\n<b>not code");

  assert.equal(rendered, "```html\n&lt;b&gt;not code");
});

test("splits empty or whitespace-only Telegram text into no chunks", () => {
  assert.deepEqual(splitTelegramText(""), []);
  assert.deepEqual(splitTelegramText("   \n\t  "), []);
});

test("splits Telegram text at readable boundaries without exceeding the limit", () => {
  const source = "alpha beta gamma delta epsilon zeta";
  const chunks = splitTelegramText(source, 12);

  assert.deepEqual(chunks, ["alpha beta", "gamma delta", "epsilon zeta"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
  assert.equal(chunks.join(" "), source);
});

test("falls back to hard splits when no readable boundary exists", () => {
  const chunks = splitTelegramText("abcdefghijklmnop", 5);

  assert.deepEqual(chunks, ["abcde", "fghij", "klmno", "p"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 5));
});
