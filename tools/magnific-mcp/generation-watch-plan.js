export function generationWatchTasks(jobId, watchToken, now = Date.now(), durationSeconds = 1800) {
  const offsets = [5, 10, 15, 20, 30, 45, 60, 90, 120];
  for (let offset = 180; offset <= durationSeconds; offset += 60) offsets.push(offset);
  return offsets.map((offset) => ({
    kind: "poll_tool",
    runAt: new Date(now + offset * 1000).toISOString(),
    payload: {
      toolName: "magnific-mcp",
      args: { action: "watch-generation", jobId, watchToken }
    }
  }));
}
