export function escapeHtml(text = "") {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInline(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

export function renderTelegramHtml(text = "") {
  const source = String(text || "");
  const parts = [];
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf("```", index);
    if (start === -1) {
      parts.push(formatInline(source.slice(index)));
      break;
    }

    if (start > index) {
      parts.push(formatInline(source.slice(index, start)));
    }

    const afterFence = start + 3;
    const lineEnd = source.indexOf("\n", afterFence);
    const languageLine = lineEnd === -1 ? source.slice(afterFence) : source.slice(afterFence, lineEnd);
    const codeStart = lineEnd === -1 ? afterFence : lineEnd + 1;
    const end = source.indexOf("```", codeStart);

    if (end === -1) {
      parts.push(formatInline(source.slice(start)));
      break;
    }

    const language = languageLine.trim();
    const code = source.slice(codeStart, end).replace(/\n$/, "");
    const languageAttr = language ? ` language="${escapeHtml(language)}"` : "";
    parts.push(`<pre><code${languageAttr}>${escapeHtml(code)}</code></pre>`);
    index = end + 3;
  }

  return parts.join("");
}
