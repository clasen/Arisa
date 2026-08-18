const timeoutPattern = /(?:timed out|timeout|connection closed before response|IPC was unavailable)/i;
const mutatingActions = new Set(["remember", "promote", "update", "forget", "reindex"]);

export function classifyContextTimeout(error, action) {
  const message = String(error?.message || error || "");
  if (!timeoutPattern.test(message)) return null;
  const normalizedAction = String(action || "unknown").toLowerCase();
  const mutating = mutatingActions.has(normalizedAction);
  return {
    status: mutating ? "outcome_uncertain" : "timed_out",
    error: mutating
      ? `Context Vault ${normalizedAction} timed out with an uncertain outcome; do not retry automatically.`
      : `Context Vault ${normalizedAction} timed out before a result was available.`,
    operation: { tool: "context-vault", action: normalizedAction, mutating },
    resolution: {
      type: mutating ? "check_operation_status" : "retry_safe",
      tool: "context-vault",
      action: normalizedAction
    }
  };
}
