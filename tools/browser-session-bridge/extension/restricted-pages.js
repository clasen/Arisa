export function isRestrictedScriptError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("extensions gallery cannot be scripted")
    || message.includes("the extensions gallery cannot be scripted");
}
