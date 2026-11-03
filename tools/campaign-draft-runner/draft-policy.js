export function draftLimit(args, profile, config = {}) {
  const requested = Number(args.limit ?? profile.limit ?? config.DEFAULT_LIMIT ?? 1);
  const configuredCap = Number(profile.maxDraftsPerRun ?? 10);
  const cap = args.action === "draft-one" ? 1 : configuredCap;
  if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(configuredCap) || configuredCap < 1 || !Number.isSafeInteger(cap) || cap < 1) {
    throw new Error("Draft limits must be positive integers");
  }
  return Math.min(10, configuredCap, cap, requested);
}

export function coverageHostAllowed(url, allowedHosts = []) {
  if (!allowedHosts.length) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && allowedHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
