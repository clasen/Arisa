import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveProspect } from "../prospect-pool.js";
import { promoteProspectTransaction, promotedProspectDrift } from "../promotion-workflow.js";

const sourceUrl = "https://youtube.com/watch?v=example";
const contact = {
  email: "creator@example.com",
  outlet: "Example Creator",
  coverageSourceUrl: sourceUrl,
  contactSourceUrl: "https://youtube.com/@example",
  groundedOpening: "I watched the creator's exact comparable-game coverage.",
  language: "en"
};

async function withProspect(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "campaign-promotion-"));
  try {
    await saveProspect(directory, "castle-bravo", {
      sourceUrl,
      name: "Example Creator",
      outlet: "Example Creator",
      segment: "walkthrough-video",
      platform: "youtube",
      evidence: "Exact comparable coverage.",
      scoreSignals: { thematicFit: 30 }
    });
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("promotion confirms persisted deliverability before changing prospect status", async () => {
  await withProspect(async (stateDir) => {
    const result = await promoteProspectTransaction({
      stateDir,
      profileName: "castle-bravo",
      sourceUrl,
      contact,
      addContact: async () => ({ contact: { ...contact } }),
      listContacts: async () => ({ contacts: [{ ...contact, emailCheck: { deliverable: true } }] })
    });
    assert.equal(result.prospect.status, "promoted");
    assert.equal(result.prospect.publicEmail, contact.email);
  });
});

test("promotion leaves prospect unchanged when campaign persistence cannot be confirmed", async () => {
  await withProspect(async (stateDir) => {
    await assert.rejects(() => promoteProspectTransaction({
      stateDir,
      profileName: "castle-bravo",
      sourceUrl,
      contact,
      addContact: async () => ({ contact: { ...contact } }),
      listContacts: async () => ({ contacts: [] })
    }), /without a persisted matching contact/);
  });
});

test("eligibility drift reports promoted prospects missing from campaign contacts", () => {
  const drift = promotedProspectDrift([
    { status: "promoted", sourceUrl, outlet: "Missing", publicEmail: "missing@example.com" },
    { status: "promoted", sourceUrl: "https://example.com/ok", outlet: "Present", publicEmail: "ok@example.com" }
  ], [{ email: "ok@example.com", emailCheck: { deliverable: true } }]);
  assert.equal(drift.count, 1);
  assert.deepEqual(drift.records[0].reasons, ["promoted-contact-not-persisted"]);
});
