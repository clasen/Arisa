import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessSearchQuality, discoverContacts, getFactSheetStatus, isSelectable, normalizeCanonicalUrls, updateApprovedFacts, validateDraftContent } from "../index.js";

const contact = {
  email: "actu@example.fr",
  outlet: "Exemple",
  angle: "Une rédaction qui couvre les enquêtes et la narration",
  sourceUrl: "https://example.fr/test/jeu"
};

const profile = (agentDecidesEligibility) => ({
  selection: {
    agentDecidesEligibility,
    includeKeywords: ["game", "review", "mystery"],
    requiredKeywordGroups: [["narrative", "detective"]],
    excludeKeywords: ["paid", "advertising"],
    allowedLanguages: ["fr"],
    requireSourceProvenance: false
  },
  languageDetection: [{ language: "fr", match: "\\.fr(?:/|$)" }],
  defaultLanguage: "en",
  discovery: { enabled: true }
});

test("fact sheet exposes only approved facts and keeps unresolved questions explicit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "campaign-facts-"));
  const factProfile = {
    name: "example",
    factSheet: {
      owner: "owner",
      fields: [
        { key: "access", question: "How is access provided?" },
        { key: "pricing", question: "What is the price?" }
      ]
    }
  };
  try {
    const initial = await getFactSheetStatus(directory, factProfile);
    assert.deepEqual(initial.approvedFacts, {});
    assert.equal(initial.pendingQuestions.length, 2);
    const updated = await updateApprovedFacts(directory, factProfile, { access: "Public download" }, "owner");
    assert.equal(updated.approvedFacts.access, "Public download");
    assert.deepEqual(updated.pendingQuestions.map((item) => item.key), ["pricing"]);
    await assert.rejects(updateApprovedFacts(directory, factProfile, { invented: "no" }, "owner"), /Unknown fact keys/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search quality switches from noisy discovery to source-directed fallback", () => {
  const poor = assessSearchQuality([{ query: "ambiguous", text: `Search: ambiguous\n\n1. The - Wikipedia\nURL: https://en.wikipedia.org/wiki/The\nSnippet: A dictionary-style result\n2. Microsoft\nURL: https://microsoft.com/\nSnippet: Unrelated software` }]);
  assert.equal(poor.quality, "poor");
  assert.equal(poor.strategy, "source-directed");
  assert.equal(poor.irrelevanceRate, 1);

  const healthy = assessSearchQuality([{ query: "Duskwood Rezension", text: `Search: Duskwood Rezension\n\n1. Duskwood: Krimi-Spiel mit Suchtpotential\nURL: https://levelup.chip.de/duskwood-krimi-spiel-mit-suchtpotential/\nSnippet: Eine Rezension des mobilen Krimispiels\n2. Duskwood - Wikipedia\nURL: https://en.wikipedia.org/wiki/Duskwood\nSnippet: Reference page` }]);
  assert.equal(healthy.quality, "healthy");
  assert.equal(healthy.relevantCoverageResults, 1);
  assert.equal(healthy.strategy, "coverage-expansion");
});

test("agent eligibility bypasses positive keyword gates", () => {
  assert.equal(isSelectable(contact, profile(false)), false);
  assert.equal(isSelectable(contact, profile(true)), true);
});

test("agent eligibility keeps negative exclusions", () => {
  assert.equal(isSelectable({ ...contact, angle: "paid advertising offer" }, profile(true)), false);
});

test("agent eligibility disables automatic discovery", async () => {
  const result = await discoverContacts(null, "chat", profile(true), [], new Set(), 1);
  assert.equal(result.found, 0);
  assert.equal(result.searches, 0);
  assert.equal(result.skipped, "agent-review-required");
});

test("strict provenance requires separate coverage, contact, and opening evidence", () => {
  const strictProfile = profile(true);
  strictProfile.selection.requireCoverageSourceProvenance = true;
  strictProfile.selection.requireContactSourceProvenance = true;
  strictProfile.selection.requireGroundedOpening = true;
  assert.equal(isSelectable(contact, strictProfile), false);
  assert.equal(isSelectable({
    ...contact,
    coverageSourceUrl: contact.sourceUrl,
    contactSourceUrl: "https://example.fr/contact",
    groundedOpening: "Votre test exact a motivé ce message."
  }, strictProfile), true);
});

test("draft preflight rejects missing grounded evidence", () => {
  const draftProfile = {
    draftValidation: {
      requireCoverageSource: true,
      requireContactSource: true,
      requireGroundedOpening: true,
      requireCoverageTitle: true
    }
  };
  assert.throws(() => validateDraftContent({
    contact: { referenceGame: "Scriptic" },
    language: "en",
    body: "Hello",
    profile: draftProfile
  }), /Draft preflight failed/);
});

test("draft preflight accepts grounded evidence without requiring the verbatim coverage title", () => {
  const groundedContact = {
    coverageTitle: "Scriptic: Netflix Edition, la recensione",
    groundedOpening: "Giorgio Melani reviewed Scriptic: Netflix Edition for Multiplayer.it.",
    coverageSourceUrl: "https://multiplayer.it/review",
    contactSourceUrl: "https://multiplayer.it/contatti/",
    language: "en"
  };
  assert.equal(validateDraftContent({
    contact: groundedContact,
    language: "en",
    body: `${groundedContact.groundedOpening}\n\nThe full article title does not need to be repeated here.`,
    profile: { draftValidation: { requireCoverageSource: true, requireContactSource: true, requireGroundedOpening: true, requireCoverageTitle: true } }
  }), true);
});

test("canonical campaign URLs gain one trailing slash", () => {
  const body = "https://castlebravo.org and https://castlebravo.org/path";
  assert.equal(
    normalizeCanonicalUrls(body, { "https://castlebravo.org": "https://castlebravo.org/" }),
    "https://castlebravo.org/ and https://castlebravo.org/path"
  );
});
