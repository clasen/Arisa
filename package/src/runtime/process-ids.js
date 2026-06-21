export function parseProcessIds(commandOutput) {
  if (!commandOutput) return [];

  return commandOutput
    .split(/\s+/)
    .filter((token) => /^\d+$/.test(token))
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
