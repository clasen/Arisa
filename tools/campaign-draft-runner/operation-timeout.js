const timeoutPattern = /(?:timed out|timeout|connection closed before response|IPC was unavailable)/i;

const mutatingActions = new Set([
  "add-contact",
  "create-draft",
  "facts-update",
  "record-bounce",
  "record-offer",
  "record-sent",
  "record-sent-batch",
  "send",
  "sources-record"
]);

export function classifyToolTimeout(error, tool, action) {
  const message = String(error?.message || error || "");
  if (!timeoutPattern.test(message)) return null;
  const normalizedAction = String(action || "unknown").toLowerCase();
  const mutating = mutatingActions.has(normalizedAction);
  return {
    ok: false,
    status: mutating ? "outcome_uncertain" : "timed_out",
    error: mutating
      ? `Outcome uncertain after ${tool} ${normalizedAction} timed out; do not retry automatically.`
      : `${tool} ${normalizedAction} timed out before a result was available.`,
    operation: { tool, action: normalizedAction, mutating },
    resolution: {
      type: mutating ? "check_operation_status" : "retry_safe",
      tool,
      action: normalizedAction
    }
  };
}

export function classifyBlockedPrerequisite(result, tool, action) {
  if (!result || !["blocked_auth", "blocked_prerequisite"].includes(result.status)) return null;
  const normalizedAction = String(action || "unknown").toLowerCase();
  return {
    ok: false,
    status: "blocked_prerequisite",
    disposition: "blocked-prerequisite",
    error: `${tool} ${normalizedAction} is blocked by an authentication prerequisite. No campaign changes were made after this result.`,
    operation: { tool, action: normalizedAction, mutating: false },
    prerequisite: { type: "authentication", tool },
    resolution: {
      type: "restore_prerequisite",
      tool,
      action: normalizedAction
    }
  };
}

export function toolOutcomeError(outcome) {
  const error = new Error(outcome.error);
  error.toolResult = outcome;
  return error;
}
