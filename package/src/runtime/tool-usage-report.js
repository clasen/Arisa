import { renderTextReport, reportRow } from "./report-format.js";

export function formatToolUsageReport(tools) {
  const lines = ["Arisa tools", "===========", "Usage count"];
  if (!tools.length) lines.push("  (none installed)");
  for (const tool of tools) {
    lines.push(...reportRow(tool.name, tool.count, { labelWidth: 24 }));
  }
  return renderTextReport(lines);
}
