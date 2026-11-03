// Cookie snapshots are complete for each captured domain. Never resurrect cookies
// absent from a newer snapshot of that same domain.
export function sessionObservedAt(session) {
  const times = [session.refreshedAt, session.receivedAt, session.capturedAt]
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

export function mergeGoogleSessionCookies(primary, related = []) {
  const domains = new Map();
  for (const session of [primary, ...related]) {
    const grouped = new Map();
    for (const cookie of session.cookies || []) {
      const domain = cookie.domain.toLowerCase().replace(/^\./, "");
      if (!grouped.has(domain)) grouped.set(domain, []);
      grouped.get(domain).push(cookie);
    }
    for (const [domain, cookies] of grouped) {
      const time = sessionObservedAt(session);
      if (!domains.has(domain) || time > domains.get(domain).time) domains.set(domain, { time, cookies });
    }
  }
  return [...domains.values()].flatMap(({ cookies }) => cookies);
}

export function isAuthenticatedStorePage(urlValue, text) {
  try {
    const url = new URL(urlValue);
    return url.protocol === "https:" && url.hostname === "chrome.google.com"
      && url.pathname.startsWith("/webstore/devconsole/")
      && /Publisher\s*:/.test(text)
      && !/Choose an account|Sign in\s+to continue|Signed out/i.test(text);
  } catch { return false; }
}

export async function chromeWebStoreTargetValidated(context) {
  const pages = context.pages();
  if (!pages.length) return false;
  for (const page of pages) {
    try {
      if (!isAuthenticatedStorePage(page.url(), await page.locator("body").innerText({ timeout: 5000 }))) return false;
    } catch { return false; }
  }
  return true;
}
