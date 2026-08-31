const SHARED_COOKIE_DOMAINS = ["google.com", "instagram.com"];

export function relatedCookieUrls(url) {
  const googleProduct = url.hostname === "google.com" || url.hostname.endsWith(".google.com");
  return googleProduct && url.hostname !== "accounts.google.com" ? [new URL("https://accounts.google.com/")] : [];
}

export function temporarySiteOrigins(url) {
  const origins = [`${url.protocol}//${url.hostname}/*`];
  for (const domain of SHARED_COOKIE_DOMAINS) {
    if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) {
      origins.push(`${url.protocol}//*.${domain}/*`);
      break;
    }
  }
  return [...new Set(origins)];
}
