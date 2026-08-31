const PENDING_SEND_TTL_MS = 2 * 60 * 1000;

export function pendingSessionSend(tab, url, now = Date.now()) {
  if (!Number.isInteger(tab?.id) || !["http:", "https:"].includes(url?.protocol)) throw new Error("Invalid pending session capture");
  return {
    version: 1,
    tabId: tab.id,
    origin: url.origin,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_SEND_TTL_MS).toISOString()
  };
}

export function shouldResumeSessionSend(record, tab, url, now = Date.now()) {
  return record?.version === 1
    && record.tabId === tab?.id
    && record.origin === url?.origin
    && new Date(record.expiresAt || 0).getTime() > now;
}
