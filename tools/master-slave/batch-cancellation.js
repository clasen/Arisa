export function bindBatchCancellation(runner, batchId, signal) {
  if (!signal) return () => {};
  const cancel = () => runner.cancel(batchId);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}
