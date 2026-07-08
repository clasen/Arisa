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

export function splitTelegramText(text = "", maxLength = 3500) {
  const source = String(text || "").trim();
  if (!source) return [];
  if (source.length <= maxLength) return [source];

  const chunks = [];
  let remaining = source;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < Math.floor(maxLength / 2)) cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength / 2)) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
