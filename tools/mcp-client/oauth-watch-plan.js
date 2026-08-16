export function oauthWatchTasks(profile, watchId, expiresAt, now = Date.now()) {
  const remainingSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const offsets = [5, 10, 15, 20, 30, 45, 60];
  for (let offset = 90; offset <= remainingSeconds; offset += 30) offsets.push(offset);
  return offsets
    .filter((offset) => offset < remainingSeconds)
    .map((offset) => ({
      kind: "poll_tool",
      runAt: new Date(now + offset * 1000).toISOString(),
      payload: { toolName: "mcp-client", args: { action: "oauth-watch", profile, watchId } }
    }));
}
