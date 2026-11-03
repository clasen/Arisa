const SHARED_COOKIE_DOMAINS = ["google.com", "instagram.com", "youtube.com"];

export function relatedCookieUrls(url) {
  const googleProduct = url.hostname === "google.com" || url.hostname.endsWith(".google.com");
  return googleProduct && url.hostname !== "accounts.google.com" ? [new URL("https://accounts.google.com/")] : [];
}

export function temporarySiteOrigins(url) {
  // Chromium checks non-Secure cookies against HTTP host permissions even
  // when getAll() targets an HTTPS page. Keep both grants temporary.
  const origins = [`http://${url.hostname}/*`, `https://${url.hostname}/*`];
  for (const domain of SHARED_COOKIE_DOMAINS) {
    if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) {
      origins.push(`http://*.${domain}/*`, `https://*.${domain}/*`);
      break;
    }
  }
  return [...new Set(origins)];
}
