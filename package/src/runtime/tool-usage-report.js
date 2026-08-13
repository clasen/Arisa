import { renderTextReport } from "./report-format.js";

export function formatToolUsageReport(tools) {
  const lines = ["Arisa tools", "===========", "Usage count"];
  if (!tools.length) lines.push("  (none installed)");

  const sortedTools = [...tools].sort((left, right) =>
    Number(right.count) - Number(left.count) || String(left.name).localeCompare(String(right.name))
  );
  const nameWidth = Math.max(0, ...sortedTools.map((tool) => String(tool.name).length));
  const countWidth = Math.max(1, ...sortedTools.map((tool) => String(tool.count).length));
  for (const tool of sortedTools) {
    const name = String(tool.name).padEnd(nameWidth);
    const count = String(tool.count).padStart(countWidth);
    lines.push(`- ${name} ${count}`);
  }
  return renderTextReport(lines);
}
