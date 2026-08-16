export function normalizeContactEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function canonicalContactEmail(value) {
  const normalized = normalizeContactEmail(value);
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0) return normalized;
  let local = normalized.slice(0, separator);
  let domain = normalized.slice(separator + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+", 1)[0].replaceAll(".", "");
  }
  return `${local}@${domain}`;
}

function emailDomain(value) {
  return normalizeContactEmail(value).split("@").at(1) || "";
}

function contactSummary(contact) {
  return {
    email: normalizeContactEmail(contact.email),
    status: contact.status || "unknown",
    outlet: contact.outlet || "",
    hasOpenDraft: Array.isArray(contact.drafts) && contact.drafts.some((draft) => draft.status === "open")
  };
}

export function checkContactDuplicate(state, value) {
  const email = normalizeContactEmail(value);
  const canonicalEmail = canonicalContactEmail(email);
  const domain = emailDomain(email);
  const contacts = Object.values(state.contacts || {});
  const exactContacts = contacts
    .filter((contact) => canonicalContactEmail(contact.email) === canonicalEmail)
    .map(contactSummary);
  const sameDomainContacts = contacts
    .filter((contact) => emailDomain(contact.email) === domain && canonicalContactEmail(contact.email) !== canonicalEmail)
    .map(contactSummary);
  const priorSends = (state.sends || []).filter((entry) => canonicalContactEmail(entry.email) === canonicalEmail);
  return {
    email,
    canonicalEmail,
    domain,
    duplicate: exactContacts.length > 0 || priorSends.length > 0,
    sameDomainReviewRequired: sameDomainContacts.length > 0,
    safeToAdd: exactContacts.length === 0 && priorSends.length === 0 && sameDomainContacts.length === 0,
    exactContacts,
    sameDomainContacts,
    priorSendCount: priorSends.length
  };
}
