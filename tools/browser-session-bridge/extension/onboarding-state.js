const MAX_SETUP_CODE_LENGTH = 4096;

export function pendingSetupRecord(code, setup, { resume = false, now = Date.now() } = {}) {
  const value = String(code || "").trim();
  if (!value.startsWith("arisa-enroll://") || value.length > MAX_SETUP_CODE_LENGTH) throw new Error("Invalid pending setup code");
  const expiresAt = new Date(setup?.expiresAt || 0).toISOString();
  if (new Date(expiresAt).getTime() <= now) throw new Error("This setup link has expired");
  return {
    version: 1,
    code: value,
    endpoint: String(setup.endpoint || ""),
    expiresAt,
    resume: resume === true,
    savedAt: new Date(now).toISOString()
  };
}

export function restorableSetupCode(record, now = Date.now()) {
  if (record?.version !== 1 || typeof record.code !== "string" || !record.code.startsWith("arisa-enroll://")) return "";
  if (record.code.length > MAX_SETUP_CODE_LENGTH || new Date(record.expiresAt || 0).getTime() <= now) return "";
  return record.code;
}

export function setupFailureKind(error, stage = "unknown") {
  const text = String(error?.message || error || "").toLowerCase();
  if (text.includes("expired")) return "expired";
  if (text.includes("permission") || text.includes("access") && stage === "permission") return "permission";
  if (text.includes("failed to fetch") || text.includes("network") || text.includes("http 5")) return "network";
  if (text.includes("already used")) return "consumed";
  if (text.includes("invalid") || text.includes("missing")) return "invalid";
  return stage === "activation" ? "activation" : "unknown";
}

export function setupStageMessage(stage) {
  if (stage === "detected") return "Setup link detected and saved.";
  if (stage === "permission") return "Setup saved. Requesting bridge access…";
  if (stage === "activation") return "Bridge access granted. Connecting profile…";
  if (stage === "connected") return "Profile connected. Open a logged-in site and press Send current session.";
  return "Preparing profile connection…";
}
