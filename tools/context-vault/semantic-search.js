function emptySemanticResult() {
  return { indexed: 0, matches: [] };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function withSemanticSearchDeadline(search, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Semantic search timed out after ${timeoutMs}ms`);
      error.code = "SEMANTIC_SEARCH_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(search), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function semanticCandidatesWithFallback({ status, statusError, timeoutMs, search }) {
  if (status === "degraded") {
    return { semantic: emptySemanticResult(), semanticError: statusError || "Semantic index is degraded" };
  }
  if (status !== "ready") {
    return { semantic: emptySemanticResult(), semanticError: null };
  }

  try {
    return {
      semantic: await withSemanticSearchDeadline(search, timeoutMs),
      semanticError: null
    };
  } catch (error) {
    return { semantic: emptySemanticResult(), semanticError: errorMessage(error) };
  }
}
