export const reportWidth = 35;

function splitLongWord(word, width) {
  const parts = [];
  for (let index = 0; index < word.length; index += width) parts.push(word.slice(index, index + width));
  return parts;
}

export function wrapReportText(text, { firstPrefix = "", nextPrefix = firstPrefix } = {}) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [firstPrefix.trimEnd()];
  const lines = [];
  let prefix = firstPrefix;
  let content = "";
  for (const originalWord of words) {
    const width = Math.max(1, reportWidth - prefix.length);
    const parts = originalWord.length > width ? splitLongWord(originalWord, width) : [originalWord];
    for (const word of parts) {
      if (content && content.length + 1 + word.length > width) {
        lines.push(prefix + content);
        prefix = nextPrefix;
        content = "";
      }
      if (!content && word.length > Math.max(1, reportWidth - prefix.length)) {
        const fragments = splitLongWord(word, Math.max(1, reportWidth - prefix.length));
        lines.push(prefix + fragments.shift());
        prefix = nextPrefix;
        content = fragments.join("");
      } else {
        content += `${content ? " " : ""}${word}`;
      }
    }
  }
  if (content) lines.push(prefix + content);
  return lines;
}

export function reportRow(label, value, { indent = "  ", labelWidth = 10 } = {}) {
  const firstPrefix = `${indent}${String(label).padEnd(labelWidth)} `;
  return wrapReportText(value, {
    firstPrefix,
    nextPrefix: " ".repeat(firstPrefix.length)
  });
}

export function renderTextReport(lines) {
  for (const line of lines) {
    if ([...line].length > reportWidth) throw new Error(`Report line exceeds ${reportWidth} characters: ${line}`);
  }
  return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
}
