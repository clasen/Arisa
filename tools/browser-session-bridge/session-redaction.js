import { readFile } from "node:fs/promises";
import path from "node:path";

function replaceAll(text, value) {
  return value ? text.split(value).join("[redacted cookie]") : text;
}

export async function redactStoredCookieValues({ stateDir, resourceId, page, sessionPath: selectedSessionPath = null }) {
  const sessionPath = selectedSessionPath || path.join(stateDir, "sessions", `${String(resourceId || "").toLowerCase()}.json`);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  let text = String(page?.text || "");
  let title = String(page?.title || "");
  for (const cookie of session.cookies || []) {
    const value = String(cookie?.value || "");
    text = replaceAll(text, value);
    title = replaceAll(title, value);
  }
  return { ...page, title, text };
}
