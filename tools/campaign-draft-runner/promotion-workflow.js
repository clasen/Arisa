import { canonicalEvidenceUrl, listProspects, updateProspect } from "./prospect-pool.js";

function clean(value) {
  return String(value || "").trim();
}

function normalizedEmail(value) {
  return clean(value).toLowerCase();
}

function contactArray(result) {
  if (Array.isArray(result?.contacts)) return result.contacts;
  if (result?.contacts && typeof result.contacts === "object") return Object.values(result.contacts);
  return [];
}

function promotedProspectDrift(prospects, contacts) {
  const contactsByEmail = new Map(contactArray({ contacts }).map((contact) => [normalizedEmail(contact.email), contact]));
  const records = [];
  for (const prospect of prospects || []) {
    if (prospect.status !== "promoted") continue;
    const email = normalizedEmail(prospect.publicEmail);
    const contact = contactsByEmail.get(email);
    const reasons = [];
    if (!email) reasons.push("promoted-without-email");
    else if (!contact) reasons.push("promoted-contact-not-persisted");
    else if (contact.emailCheck && contact.emailCheck.deliverable !== true) reasons.push("promoted-contact-not-deliverable");
    if (reasons.length) records.push({
      sourceUrl: prospect.sourceUrl,
      outlet: prospect.outlet,
      email,
      reasons
    });
  }
  return { count: records.length, records };
}

async function promoteProspectTransaction({ stateDir, profileName, sourceUrl, contact, addContact, listContacts: readContacts }) {
  const canonicalSource = canonicalEvidenceUrl(sourceUrl);
  const prospects = await listProspects(stateDir, profileName, { limit: 500 });
  const prospect = prospects.find((item) => canonicalEvidenceUrl(item.sourceUrl) === canonicalSource);
  if (!prospect) throw new Error("No matching prospect was found");

  const email = normalizedEmail(contact?.email);
  if (!email) throw new Error("promotion requires an explicit email");
  if (canonicalEvidenceUrl(contact?.coverageSourceUrl) !== canonicalSource) {
    throw new Error("promotion coverageSourceUrl must match the prospect sourceUrl");
  }
  if (!canonicalEvidenceUrl(contact?.contactSourceUrl)) throw new Error("promotion requires contactSourceUrl");
  if (!clean(contact?.groundedOpening)) throw new Error("promotion requires groundedOpening");
  if (!clean(contact?.language)) throw new Error("promotion requires language");

  const added = await addContact({ ...contact, action: "add-contact", verify: true });
  const stored = contactArray(await readContacts()).find((item) => normalizedEmail(item.email) === email);
  if (!stored) throw new Error("add-contact returned without a persisted matching contact; prospect was not promoted");
  if (stored.emailCheck?.deliverable !== true) throw new Error("persisted contact does not have conclusive deliverability; prospect was not promoted");

  const updated = await updateProspect(stateDir, profileName, {
    sourceUrl: prospect.sourceUrl,
    status: "promoted",
    contactUrl: contact.contactSourceUrl,
    publicEmail: email,
    reason: clean(contact.promotionReason) || "Promoted transactionally after add-contact persistence and deliverability were confirmed."
  });
  return { added: added?.contact || null, confirmedContact: stored, prospect: updated.prospect };
}

export { contactArray, promoteProspectTransaction, promotedProspectDrift };
