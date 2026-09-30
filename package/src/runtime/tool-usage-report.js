import { renderTextReport, reportWidth } from "./report-format.js";

function sortedTools(tools) {
  return [...tools].sort((left, right) =>
    Number(right.count) - Number(left.count) || String(left.name).localeCompare(String(right.name))
  );
}

function splitUsageField(value, width) {
  const characters = [...String(value)];
  const parts = [];
  for (let index = 0; index < characters.length; index += width) {
    parts.push(characters.slice(index, index + width).join(""));
  }
  return parts.length ? parts : [""];
}

function usageRow(tool, nameWidth, countWidth) {
  if (nameWidth < 1) {
    const names = splitUsageField(tool.name, reportWidth - 2);
    const counts = splitUsageField(tool.count, reportWidth - 2);
    return [
      ...names.map((name, index) => `${index === 0 ? "- " : "  "}${name}`),
      ...counts.map((count) => `  ${count}`)
    ];
  }
  const names = splitUsageField(tool.name, nameWidth);
  const count = String(tool.count);
  const alignedCount = " ".repeat(countWidth - [...count].length) + count;
  return names.map((name, index) => {
    const prefix = index === 0 ? "- " : "  ";
    if (index < names.length - 1) return prefix + name;
    const alignedName = name + " ".repeat(nameWidth - [...name].length);
    return `${prefix}${alignedName}  ${alignedCount}`;
  });
}

function usageRows(tools, nameWidth, countWidth) {
  if (!tools.length) return ["  (none)"];
  return sortedTools(tools).flatMap((tool) => usageRow(tool, nameWidth, countWidth));
}

export function formatToolUsageReport(tools) {
  const official = tools.filter((tool) => tool.official);
  const local = tools.filter((tool) => !tool.official);
  const countWidth = Math.max(1, ...tools.map((tool) => [...String(tool.count)].length));
  // Reserve two columns for the bullet and two for the count separator.
  const nameWidth = Math.min(
    Math.max(0, ...tools.map((tool) => [...String(tool.name)].length)),
    reportWidth - 4 - countWidth
  );
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
