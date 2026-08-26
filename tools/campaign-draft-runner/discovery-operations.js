const allowedActions = new Set([
  "discovery-summary",
  "campaign-status",
  "list-contacts",
  "check-contact",
  "verify-email",
  "add-contact",
  "sources-check",
  "sources-record"
]);

function parseOperations(value) {
  const operations = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(operations)) throw new Error("operations must be a JSON array");
  if (!operations.length || operations.length > 50) throw new Error("operations must contain 1 to 50 items");
  return operations;
}

function compactId(value) {
  return String(value || "").trim().slice(0, 100);
}

function array(value) {
  return Array.isArray(value) ? value : null;
}

function validateOperation(operation, index, seenIds) {
  const id = compactId(operation?.id || `operation-${index + 1}`);
  const action = String(operation?.action || "").trim();
  const errors = [];
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) errors.push("operation must be an object");
  if (!id) errors.push("id is required");
  if (seenIds.has(id)) errors.push("id must be unique within the batch");
  seenIds.add(id);
  if (!allowedActions.has(action)) errors.push(`unsupported action: ${action || "empty"}`);
  if (["check-contact", "verify-email", "add-contact"].includes(action) && !String(operation?.email || "").trim()) errors.push("email is required");
  if (action === "add-contact") {
    if (!String(operation?.name || "").trim()) errors.push("name is required");
    if (!String(operation?.outlet || "").trim()) errors.push("outlet is required");
    if (operation?.updateExisting === true || String(operation?.updateExisting).toLowerCase() === "true") {
      errors.push("batch add-contact does not allow updateExisting; use an explicit single operation for destructive replacement");
    }
  }
  if (action === "sources-check" && !array(operation?.urls)) errors.push("urls must be an array");
  if (action === "sources-record" && !array(operation?.sources)) errors.push("sources must be an array");
  return { id, action, operation, errors };
}

export function prevalidateDiscoveryOperations(value) {
  const seenIds = new Set();
  return parseOperations(value).map((operation, index) => validateOperation(operation, index, seenIds));
}

function errorText(error) {
  return String(error?.message || error || "unknown error").split("\n")[0].slice(0, 300);
}

export async function executeDiscoveryOperations(value, handlers, { now = () => Date.now() } = {}) {
  const startedAt = now();
  const validated = prevalidateDiscoveryOperations(value);
  const results = [];
  for (const item of validated) {
    if (item.errors.length) {
      results.push({ id: item.id, action: item.action, ok: false, validationErrors: item.errors });
      continue;
    }
    try {
      const output = await handlers[item.action](item.operation);
      results.push({ id: item.id, action: item.action, ok: true, idempotent: true, output });
    } catch (error) {
      results.push({ id: item.id, action: item.action, ok: false, error: errorText(error) });
    }
  }
  return {
    results,
    total: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    verificationOperations: validated.filter((item) => ["check-contact", "verify-email", "sources-check"].includes(item.action)).length,
    mutationOperations: validated.filter((item) => ["add-contact", "sources-record"].includes(item.action)).length,
    durationMs: Math.max(0, now() - startedAt)
  };
}

export function campaignOperationArgs(operation) {
  const { id: _id, ...args } = operation;
  return args;
}
