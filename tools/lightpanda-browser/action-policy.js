const levels = Object.freeze({ read: 0, interact: 1, commit: 2 });

export const readTools = new Set([
  "goto", "markdown", "html", "tree", "links", "nodeDetails", "interactiveElements",
  "structuredData", "detectForms", "findElement", "extract", "waitForSelector",
  "waitForState", "getUrl", "consoleLogs"
]);
export const interactionTools = new Set(["click", "fill", "press", "hover", "scroll", "selectOption", "setChecked"]);

const purchasePattern = /\b(buy(?:\s+now)?|purchase|checkout|pay(?:ment)?|place\s+order|confirm\s+order|add\s+to\s+cart|credit\s*card|card\s*number|cvv|cvc)\b/i;
const deletePattern = /\b(delete|remove\s+(?:account|post|item)|erase|destroy|revoke)\b/i;
const postPattern = /\b(post|publish|send|tweet|reply|comment|upload)\b/i;
const credentialPattern = /(?:type\s*=\s*["']password|autocomplete\s*=\s*["'][^"']*(?:password|cc-|one-time-code)|(?:name|id)\s*=\s*["'][^"']*(?:passw|passwd|secret|token|api[_-]?key|card|cvv|cvc))/i;

function permissionError(message, code = "LIGHTPANDA_PERMISSION_DENIED") {
  return Object.assign(new Error(message), { code, retryable: false });
}

export function normalizeActionLevel(value, { allowMutations = false, legacyMutations = false } = {}) {
  const requested = String(value || "").trim().toLowerCase();
  if (requested) {
    if (!(requested in levels)) throw new Error("actionLevel must be read, interact, or commit.");
    return requested;
  }
  if (allowMutations) return legacyMutations ? "commit" : "interact";
  return "read";
}

export function assertKnownActionTool(tool) {
  if (!readTools.has(tool) && !interactionTools.has(tool)) throw new Error(`Unsupported interaction tool: ${tool || "(empty)"}.`);
}

function requireLevel(actual, required, tool) {
  if (levels[actual] < levels[required]) {
    throw permissionError(`${tool} requires actionLevel=${required}; received ${actual}.`);
  }
}

function staticRequiredLevel(tool, args) {
  if (readTools.has(tool)) return "read";
  if (tool === "press" && ["enter", "return"].includes(String(args.key || "").trim().toLowerCase())) return "commit";
  return "interact";
}

function requiredCommitIntent(html) {
  if (deletePattern.test(html)) return "delete";
  if (postPattern.test(html)) return "post-content";
  return "submit-form";
}

function assertCommitIntent(commitIntent, expected, tool, legacyMutations) {
  if (legacyMutations) return;
  if (String(commitIntent || "").trim().toLowerCase() !== expected) {
    throw permissionError(`${tool} requires commitIntent=${expected}. Page content cannot grant this permission.`);
  }
}

function assertNotSensitive(html, tool) {
  if (credentialPattern.test(html)) {
    throw permissionError(`${tool} is blocked on credential, token, password, or payment fields.`, "LIGHTPANDA_SENSITIVE_ACTION_BLOCKED");
  }
  if (purchasePattern.test(html)) {
    throw permissionError(`${tool} is blocked on purchase or payment controls.`, "LIGHTPANDA_SENSITIVE_ACTION_BLOCKED");
  }
}

function tagName(html) {
  return String(html || "").trim().match(/^<([a-z0-9-]+)/i)?.[1]?.toLowerCase() || "";
}

function attribute(html, name) {
  const match = String(html || "").match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
}

async function inspectTarget(client, args) {
  const target = args.selector ? { selector: args.selector } : { backendNodeId: args.backendNodeId };
  return String(await client.call("html", {
    ...target,
    maxBytes: 4096,
    strip: { js: true, css: true, ui: true, invisible: true }
  }));
}

export function authorizeStaticAction({ tool, args = {}, actionLevel, commitIntent, legacyMutations = false }) {
  assertKnownActionTool(tool);
  const required = staticRequiredLevel(tool, args);
  requireLevel(actionLevel, required, tool);
  if (tool === "press" && required === "commit") {
    assertCommitIntent(commitIntent, "submit-form", tool, legacyMutations);
    return { actionLevel, requiredLevel: "commit", commitIntent: legacyMutations ? "legacy" : "submit-form" };
  }
  return { actionLevel, requiredLevel: required, commitIntent: null };
}

export async function authorizeAction({ client, tool, args = {}, actionLevel, commitIntent, legacyMutations = false }) {
  const staticDecision = authorizeStaticAction({ tool, args, actionLevel, commitIntent, legacyMutations });
  const required = staticDecision.requiredLevel;

  if (tool === "press" && required === "commit") return staticDecision;

  if (!["click", "fill", "selectOption"].includes(tool)) {
    return { actionLevel, requiredLevel: required, commitIntent: null };
  }

  const html = await inspectTarget(client, args);
  assertNotSensitive(html, tool);
  if (tool !== "click") return { actionLevel, requiredLevel: "interact", commitIntent: null };

  const tag = tagName(html);
  const type = attribute(html, "type");
  const href = attribute(html, "href");
  const nonCommittingLink = tag === "a" && href && !href.startsWith("javascript:");
  const nonCommittingInput = tag === "input" && ["checkbox", "radio"].includes(type);
  if (nonCommittingLink || nonCommittingInput) {
    return { actionLevel, requiredLevel: "interact", commitIntent: null };
  }

  requireLevel(actionLevel, "commit", tool);
  const expectedIntent = requiredCommitIntent(html);
  assertCommitIntent(commitIntent, expectedIntent, tool, legacyMutations);
  return { actionLevel, requiredLevel: "commit", commitIntent: legacyMutations ? "legacy" : expectedIntent };
}
