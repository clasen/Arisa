import { renderTextReport, reportWidth } from "./report-format.js";

const kindLabels = Object.freeze({
  message: "msg",
  reaction: "react",
  task: "task",
  event: "event",
  delegate: "sub",
  new: "new",
  other: "other"
});

function runTokens(run) {
  return run.input + run.cacheRead + run.output;
}

function formatTokens(tokens) {
  if (tokens >= 999_950) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function formatTime(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function truncate(text, width) {
  const characters = [...String(text).replace(/\s+/g, " ").trim()];
  if (characters.length <= width) return characters.join("");
  return width > 1 ? `${characters.slice(0, width - 1).join("")}…` : characters.slice(0, width).join("");
}

function alignedRow(left, right, indent = "") {
  const rightWidth = [...right].length;
  const fitted = indent + truncate(left, reportWidth - rightWidth - 2 - indent.length);
  return fitted + " ".repeat(reportWidth - rightWidth - [...fitted].length) + right;
}

function runRows(run) {
  const kind = kindLabels[run.kind] || run.kind;
  const calls = `${run.modelCalls} ${run.modelCalls === 1 ? "call" : "calls"}`;
  const suffix = ` x${run.speed} · ${calls}`;
  return [
    alignedRow(`${formatTime(run.at)} ${kind} ${run.detail}`, formatTokens(runTokens(run))),
    `  ${truncate(run.model, reportWidth - 2 - [...suffix].length)}${suffix}`
  ];
}

// Renders where the chat's tokens went: totals per model, then the costliest runs first.
export function formatModelUsageReport({ runs, windowMs, maxRows }) {
  const hours = Math.round(windowMs / 3_600_000);
  const title = `Token usage (last ${hours}h)`;
  const lines = [title, "=".repeat(title.length)];
  if (!runs.length) return renderTextReport([...lines, "  (none)"]);

  const total = runs.reduce((sum, run) => sum + runTokens(run), 0);
  const calls = runs.reduce((sum, run) => sum + run.modelCalls, 0);
  lines.push(alignedRow(`Total · ${calls} calls`, formatTokens(total)));
  const byModel = new Map();
  for (const run of runs) byModel.set(run.model, (byModel.get(run.model) || 0) + runTokens(run));
  for (const [model, tokens] of [...byModel].sort((left, right) => right[1] - left[1])) {
    lines.push(alignedRow(model, formatTokens(tokens), "  "));
  }

  const ranked = [...runs].sort((left, right) => runTokens(right) - runTokens(left) || right.at.localeCompare(left.at));
  const shown = ranked.slice(0, maxRows);
  lines.push("", `Top runs (${shown.length} of ${runs.length})`);
  for (const run of shown) lines.push(...runRows(run));
  const rest = ranked.slice(maxRows);
  if (rest.length) {
    lines.push(alignedRow(`${rest.length} more`, formatTokens(rest.reduce((sum, run) => sum + runTokens(run), 0))));
  }
  return renderTextReport(lines);
}
