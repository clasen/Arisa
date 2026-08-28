export function buildTargetValidation({
  action,
  username,
  posts,
  requested,
  attempts,
  idle,
  idleLimit,
  emptyStateVisible,
  sessionSource,
  capturedAt,
  receivedAt
}) {
  const observed = posts.length;
  const target = action === "bookmarks" ? "https://x.com/i/bookmarks" : `https://x.com/${username}`;
  const conclusive = observed > 0 || emptyStateVisible;
  const reachedLimit = observed >= requested;
  const exhausted = !reachedLimit && idle >= idleLimit;
  return {
    authorization: {
      status: sessionSource === "browser-session-bridge" ? "session_shared" : "configured_cookie_fallback",
      source: sessionSource,
      ...(capturedAt ? { capturedAt } : {}),
      ...(receivedAt ? { receivedAt } : {})
    },
    target: {
      status: conclusive ? "validated" : "inconclusive",
      url: target,
      validatedAt: new Date().toISOString(),
      evidence: observed > 0 ? "visible_posts" : emptyStateVisible ? "visible_empty_state" : "none"
    },
    coverage: {
      observed,
      requested,
      attempts,
      stopReason: reachedLimit ? "requested_limit" : exhausted ? "idle_exhausted" : "scroll_budget",
      complete: exhausted || emptyStateVisible
    }
  };
}
