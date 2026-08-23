import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activeQueries, assessSearchQuality, batchSkipSettings, buildApprovedFactsBody, checkExhaustedSources, discoverContacts, getFactSheetStatus, isSelectable, normalizeCanonicalUrls, recordExhaustedSources, runTool, updateApprovedFacts, validateDraftContent } from "../index.js";
import { classifyToolTimeout } from "../operation-timeout.js";

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

test("exhausted sources are canonicalized, skipped for 30 days, and then revalidated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "campaign-sources-"));
  const now = Date.parse("2026-08-18T00:00:00.000Z");
  try {
    const stored = await recordExhaustedSources(directory, "example", [{
      url: "https://www.example.com/review/?utm_source=test#author",
      reason: "no-public-email"
    }], 30, now);
    assert.equal(stored.recorded, 1);
    const current = await checkExhaustedSources(directory, "example", ["https://example.com/review"], now + 29 * 86400000);
    assert.equal(current.active.length, 1);
    assert.deepEqual(current.available, []);
    const expired = await checkExhaustedSources(directory, "example", ["https://example.com/review"], now + 31 * 86400000);
    assert.equal(expired.active.length, 0);
    assert.deepEqual(expired.available, ["https://example.com/review"]);
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

test("tool calls retry a transient registry miss without retrying other failures", async () => {
  let attempts = 0;
  const arisa = {
    tools: {
      async run() {
        attempts += 1;
        if (attempts === 1) throw new Error("Tool not found: pr-campaign");
        return { ok: true, output: { json: { drafted: true } } };
      }
    }
  };
  assert.deepEqual(await runTool(arisa, "pr-campaign", { action: "status" }), { drafted: true });
  assert.equal(attempts, 2);

  attempts = 0;
  arisa.tools.run = async () => {
    attempts += 1;
    throw new Error("pr-campaign failed preflight");
  };
  await assert.rejects(runTool(arisa, "pr-campaign", { action: "status" }), /failed preflight/);
  assert.equal(attempts, 1);
});

test("tool timeouts distinguish uncertain mutations from retry-safe reads", () => {
  const mutation = classifyToolTimeout(new Error("Arisa IPC request timed out"), "pr-campaign", "create-draft");
  assert.equal(mutation.status, "outcome_uncertain");
  assert.equal(mutation.resolution.type, "check_operation_status");

  const read = classifyToolTimeout(new Error("Arisa IPC request timed out"), "pr-campaign", "status");
  assert.equal(read.status, "timed_out");
  assert.equal(read.resolution.type, "retry_safe");
  assert.equal(classifyToolTimeout(new Error("validation failed"), "pr-campaign", "create-draft"), null);
});

test("unchanged skipping applies to untilDrafted runs but not dry runs", () => {
  const config = { UNCHANGED_BATCH_SKIP_ENABLED: true, UNCHANGED_BATCH_FORCE_MS: 21600000, CREATIVE_REVIEW_AFTER_SKIPS: 4 };
  assert.equal(batchSkipSettings(config, {}, { untilDrafted: "true" }).enabled, true);
  assert.equal(batchSkipSettings(config, {}, { dryRun: "true" }).enabled, false);
  assert.equal(batchSkipSettings(config, { batchSkip: { enabled: false } }, {}).enabled, false);
  assert.equal(batchSkipSettings(config, {}, {}).explorationReviewAfterSkips, 0);
  assert.equal(batchSkipSettings(config, { discovery: { creativeDiscovery: { enabled: true } } }, {}).explorationReviewAfterSkips, 4);
  assert.equal(batchSkipSettings(config, {
    batchSkip: { explorationReviewAfterSkips: 2 },
    discovery: { creativeDiscovery: { enabled: true } }
  }, {}).explorationReviewAfterSkips, 2);
});

test("query cooldown prefers approaches not used recently and fails open when all are recent", () => {
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const catalog = ["recent query", "older query", "unused query"];
  const state = {
    archivedQueries: {},
    queryStats: {
      "recent query": { lastRunAt: new Date(now - 2 * 3600000).toISOString() },
      "older query": { lastRunAt: new Date(now - 30 * 3600000).toISOString() }
    }
  };
  assert.deepEqual(activeQueries(catalog, state, 24, now), ["older query", "unused query"]);
  const allRecent = {
    archivedQueries: {},
    queryStats: Object.fromEntries(catalog.map((query) => [query, { lastRunAt: new Date(now - 3600000).toISOString() }]))
  };
  assert.deepEqual(activeQueries(catalog, allRecent, 24, now), catalog);
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

test("fact-backed drafts discard legacy claims and require every declared approval", () => {
  const factsProfile = {
    factSheet: {
      draftStatements: {
        en: [{ factKeys: ["availability"], text: "The approved availability statement." }]
      }
    }
  };
  const body = buildApprovedFactsBody({
    renderedBody: "Hi Example,\n\nUnapproved legacy product claim.\n\nPlease reply.\n\nArisa",
    opening: "Grounded coverage opening.",
    profile: factsProfile,
    language: "en",
    approvedFacts: { availability: "Approved source fact" }
  });
  assert.equal(body, "Hi Example,\n\nGrounded coverage opening.\n\nThe approved availability statement.\n\nPlease reply.\n\nArisa");
  assert.doesNotMatch(body, /legacy product claim/);
  assert.throws(() => buildApprovedFactsBody({
    renderedBody: "Hi Example,\n\nOld claim.\n\nPlease reply.\n\nArisa",
    opening: "Grounded coverage opening.",
    profile: factsProfile,
    language: "en",
    approvedFacts: {}
  }), /unapproved facts availability/);
});

test("canonical campaign URLs gain one trailing slash", () => {
  const body = "https://castlebravo.org and https://castlebravo.org/path";
  assert.equal(
    normalizeCanonicalUrls(body, { "https://castlebravo.org": "https://castlebravo.org/" }),
    "https://castlebravo.org/ and https://castlebravo.org/path"
  );
});
