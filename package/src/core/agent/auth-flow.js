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

export function buildPiAuthTelegramMessage({ config, issue = null }) {
  const status = getPiAuthStatus(config);
  const lines = [
    issue
      ? `Pi authentication needs attention for ${status.provider}/${status.model}.`
      : `Pi authentication status for ${status.provider}/${status.model}.`
  ];

  if (issue?.kind === "invalidated-token") {
    lines.push("The provider says the current authentication token was invalidated.");
  } else if (issue?.kind === "missing-auth") {
    lines.push("Arisa could not find usable authentication for this provider.");
  } else {
    lines.push(`Stored auth: ${status.hasStoredAuth ? "detected" : "not detected"}.`);
  }

  if (issue?.message) {
    lines.push(`Details: ${issue.message}`);
  }

  if (status.hasApiKey) {
    lines.push("A Pi API key is configured, but the provider rejected the current request. Update the key and restart Arisa.");
  } else if (status.supportsOAuth) {
    lines.push("For now, re-run `arisa --bootstrap` on the host and complete Pi login again.");
  } else {
    lines.push("This provider needs a Pi API key. Re-run `arisa --bootstrap`, provide a key, and restart Arisa.");
  }

  lines.push("Telegram-based renewal is not wired yet, but this /auth path is ready for that flow.");
  return lines.join("\n");
}
