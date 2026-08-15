import { renderTextReport } from "./report-format.js";

function sortedTools(tools) {
  return [...tools].sort((left, right) =>
    Number(right.count) - Number(left.count) || String(left.name).localeCompare(String(right.name))
  );
}

function usageRows(tools, nameWidth, countWidth) {
  if (!tools.length) return ["  (none)"];
  return sortedTools(tools).map((tool) => {
    const name = String(tool.name).padEnd(nameWidth);
    const count = String(tool.count).padStart(countWidth);
    return `- ${name}  ${count}`;
  });
}

export function formatToolUsageReport(tools) {
  const official = tools.filter((tool) => tool.official);
  const local = tools.filter((tool) => !tool.official);
  const nameWidth = Math.max(0, ...tools.map((tool) => String(tool.name).length));
  const countWidth = Math.max(1, ...tools.map((tool) => String(tool.count).length));
  const lines = [
    "Arisa tools",
    "===========",
    "Official",
    ...usageRows(official, nameWidth, countWidth),
    "",
    "Local",
    ...usageRows(local, nameWidth, countWidth)
  ];
  return renderTextReport(lines);
}
