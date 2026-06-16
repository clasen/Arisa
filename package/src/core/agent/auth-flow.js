import { createPiRuntime, hasProviderAuth, supportsProviderOAuth } from "./pi-runtime.js";

const authInvalidatedPatterns = [
  /authentication token has been invalidated/i,
  /token (?:has been )?invalidated/i,
  /try signing in again/i,
  /auth(?:entication)? token (?:expired|revoked|invalid)/i
];

const missingAuthPatterns = [
  /no auth found/i,
  /auth(?:entication)? .*missing/i
];

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function getPiAuthIssue(error) {
  const message = getErrorMessage(error);
  if (!message) return null;

  if (authInvalidatedPatterns.some((pattern) => pattern.test(message))) {
    return { kind: "invalidated-token", message };
  }

  if (missingAuthPatterns.some((pattern) => pattern.test(message))) {
    return { kind: "missing-auth", message };
  }

  return null;
}

export function getPiAuthStatus(config) {
  const runtime = createPiRuntime({
    provider: config.pi.provider,
    apiKey: config.pi.apiKey
  });

  return {
    provider: config.pi.provider,
    model: config.pi.model,
    hasApiKey: Boolean(config.pi.apiKey),
    hasStoredAuth: hasProviderAuth(config.pi.provider, runtime),
    supportsOAuth: supportsProviderOAuth(config.pi.provider, runtime)
  };
}

export function buildPiAuthTelegramMessage({ config, issue = null, verified = false }) {
  const status = getPiAuthStatus(config);
  let title = `Pi authentication status for ${status.provider}/${status.model}.`;
  if (issue) {
    title = `Pi authentication needs attention for ${status.provider}/${status.model}.`;
  } else if (verified) {
    title = `Pi authentication is working for ${status.provider}/${status.model}.`;
  }
  const lines = [title];

  if (issue?.kind === "invalidated-token") {
    lines.push("The provider says the current authentication token was invalidated.");
  } else if (issue?.kind === "missing-auth") {
    lines.push("Arisa could not find usable authentication for this provider.");
  } else if (issue?.kind === "validation-failed") {
    lines.push("Arisa could not validate the current Pi authentication.");
  } else if (verified) {
    lines.push(status.hasApiKey
      ? "The configured Pi API key was accepted by the provider."
      : "The stored auth was accepted by the provider.");
  } else {
    lines.push(`Stored auth record: ${status.hasStoredAuth ? "detected" : "not detected"}.`);
    lines.push("This only checks whether credentials are stored, not whether the provider will accept them.");
  }

  if (issue?.message) {
    lines.push(`Details: ${issue.message}`);
  }

  if (verified) {
    lines.push("No action needed.");
  } else if (!issue) {
    lines.push("Run `/auth` to validate these credentials against the provider.");
  } else if (status.hasApiKey) {
    lines.push("A Pi API key is configured, but the provider rejected the current request. Update the key and restart Arisa.");
  } else if (status.supportsOAuth) {
    lines.push("Run `/auth` here in Telegram to renew the Pi login.");
  } else {
    lines.push("This provider needs a Pi API key. Re-run `arisa --bootstrap`, provide a key, and restart Arisa.");
  }

  return lines.join("\n");
}

export function buildPiAuthRecoveryBlockedMessage({ config, issue = null, renewalActive = false }) {
  const status = getPiAuthStatus(config);
  const lines = [
    `Pi authentication is not ready for ${status.provider}/${status.model}.`,
    "I did not send your message to the agent."
  ];

  if (issue?.message) {
    lines.push(`Details: ${issue.message}`);
  }

  lines.push(renewalActive
    ? "A Pi login is already in progress. Paste the redirect URL or code here when the provider gives it to you."
    : "Send `/auth` to start Pi login from Telegram.");

  return lines.join("\n");
}
