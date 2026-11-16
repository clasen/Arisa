import { renderTextReport, reportWidth, wrapReportText } from "./report-format.js";

const kindLabels = Object.freeze({
  message: "message",
  reaction: "reaction",
  task: "task",
  event: "event",
  delegate: "subagent",
  new: "new chat",
  other: "other"
});

const detailLines = 2;

function runTokens(run) {
  return run.input + run.cacheRead + run.output;
}

function sumTokens(runs) {
  return runs.reduce((sum, run) => sum + runTokens(run), 0);
}

function sumCalls(runs) {
  return runs.reduce((sum, run) => sum + run.modelCalls, 0);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
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
  return width > 1 ? `${characters.slice(0, width - 1).join("").trimEnd()}…` : characters.slice(0, width).join("");
}

function alignedRow(left, right, indent = "") {
  const rightWidth = [...right].length;
  const fitted = indent + truncate(left, reportWidth - rightWidth - 2 - indent.length);
  return fitted + " ".repeat(reportWidth - rightWidth - [...fitted].length) + right;
}

function wrappedDetail(detail) {
  const text = String(detail).replace(/\s+/g, " ").trim();
  const lines = wrapReportText(text, { firstPrefix: "  " });
  if (lines.length <= detailLines) return lines;
  const kept = lines.slice(0, detailLines - 1);
  const shownLength = kept.reduce((length, line) => length + line.length - 1, 0);
  return [...kept, `  ${truncate(text.slice(shownLength), reportWidth - 2)}`];
}

function runRows(run) {
  const kind = kindLabels[run.kind] || run.kind;
  return [
    alignedRow(`${formatTime(run.at)} ${kind} · ${plural(run.modelCalls, "call")}`, formatTokens(runTokens(run))),
    ...wrappedDetail(run.detail)
  ];
}

function profileOf(run) {
  return `${run.model} · ${run.speed}x`;
}

// Renders where the chat's tokens went: one section per model and speed, costliest runs first.
export function formatModelUsageReport({ runs, windowMs, maxRows }) {
  const hours = Math.round(windowMs / 3_600_000);
  const title = `Token usage (last ${hours}h)`;
  const lines = [title, "=".repeat(title.length)];
  if (!runs.length) return renderTextReport([...lines, "  (none)"]);

  const total = sumTokens(runs);
  lines.push(alignedRow("Total", formatTokens(total)), `  ${plural(runs.length, "run")} · ${plural(sumCalls(runs), "call")}`);

  const ranked = [...runs].sort((left, right) => runTokens(right) - runTokens(left) || right.at.localeCompare(left.at));
  const shown = new Set(ranked.slice(0, maxRows));
  const profiles = new Map();
  for (const run of ranked) {
    const profile = profileOf(run);
    if (!profiles.has(profile)) profiles.set(profile, []);
    profiles.get(profile).push(run);
  }

  const sections = [...profiles].sort((left, right) => sumTokens(right[1]) - sumTokens(left[1]));
  for (const [profile, profileRuns] of sections) {
    const tokens = sumTokens(profileRuns);
    const share = `${Math.round((tokens / total) * 100)}%`;
    lines.push(
      "",
      alignedRow(profile, `${formatTokens(tokens)} · ${share}`),
      `  ${plural(profileRuns.length, "run")} · ${plural(sumCalls(profileRuns), "call")}`,
      "-".repeat(reportWidth)
    );
    for (const run of profileRuns.filter((entry) => shown.has(entry))) lines.push(...runRows(run));
    const rest = profileRuns.filter((entry) => !shown.has(entry));
    if (rest.length) lines.push(alignedRow(`+${plural(rest.length, "more run")}`, formatTokens(sumTokens(rest))));
  }
  return renderTextReport(lines);
}
