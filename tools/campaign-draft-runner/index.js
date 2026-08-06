import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";

const toolName = "campaign-draft-runner";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || process.env.ARISA_INSTALL_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { getChatToolStateDir, getChatToolTmpDir } = await importCore("runtime/paths.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createArisaClient } = await importCore("core/tools/ipc-client.js");

function printHelp() {
  console.log(`campaign-draft-runner

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  run-batch   Verify contacts selected by a profile and create Gmail drafts only. args: profile?, limit?, dryRun?
  status      Return campaign status and Gmail draft count. args: profile?

Profiles live under the chat-scoped state directory:
  <chatToolStateDir>/profiles/<profile>.json

Profiles may enable web research to cite relevant articles or videos in the opening paragraph.
The runner is generic. Campaign-specific copy, keywords, language detection, and tool names belong in the profile JSON.`);
}

function clean(value) { return String(value || "").trim(); }
function normalizedEmail(value) { return clean(value).toLowerCase(); }
function truthy(value) { return value === true || value === "true" || value === "1" || value === 1 || value === "yes"; }

async function loadProfile(chatId, profileName) {
  const safeName = clean(profileName).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeName) throw new Error("profile is required");
  const file = path.join(getChatToolStateDir(chatId, toolName), "profiles", `${safeName}.json`);
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function outletKey(contact) {
  return clean(contact.outlet).toLowerCase().replace(/\s*\/.*$/, "").replace(/\s*\(.*?\)\s*/g, "").replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function contactText(contact) {
  return `${contact.email || ""} ${contact.name || ""} ${contact.outlet || ""} ${contact.angle || ""} ${contact.referenceGame || ""} ${contact.personalNote || ""} ${contact.market || ""} ${contact.sourceUrl || ""}`.toLowerCase();
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(text));
}

function scoreContact(contact, profile) {
  const text = contactText(contact);
  let total = 0;
  for (const [pattern, value] of Object.entries(profile.selection?.scoreKeywords || {})) {
    if (new RegExp(pattern, "i").test(text)) total += Number(value || 0);
  }
  return total;
}

function isSelectable(contact, profile) {
  const text = contactText(contact);
  const include = profile.selection?.includeKeywords || [];
  const exclude = profile.selection?.excludeKeywords || [];
  const allowedLanguages = profile.selection?.allowedLanguages || [];
  const requiredKeywordGroups = profile.selection?.requiredKeywordGroups || [];
  if (include.length && !matchesAny(text, include)) return false;
  if (requiredKeywordGroups.some((patterns) => !matchesAny(text, patterns))) return false;
  if (exclude.length && matchesAny(text, exclude)) return false;
  if (allowedLanguages.length && !allowedLanguages.includes(detectLanguage(contact, profile))) return false;
  return true;
}

function detectLanguage(contact, profile) {
  const text = contactText(contact);
  for (const rule of profile.languageDetection || []) {
    if (new RegExp(rule.match, "i").test(text)) return rule.language;
  }
  return profile.defaultLanguage || "en";
}

function render(template, contact, profile) {
  const values = {
    outlet: clean(contact.outlet || contact.name || "there"),
    name: clean(contact.name || contact.outlet || "there"),
    email: clean(contact.email),
    referenceGame: clean(contact.referenceGame),
    personalNote: clean(contact.personalNote),
    angle: clean(contact.angle),
    profile: clean(profile.name)
  };
  return String(template || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] ?? "");
}

function sourceHost(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function personalizationQuery(contact, settings) {
  const outlet = clean(contact.outlet || contact.name || "");
  const reference = clean(contact.referenceGame);
  const identity = [outlet, reference].filter(Boolean).join(" ");
  const suffix = clean(settings.querySuffix || "game review OR feature OR video");
  const host = sourceHost(contact.sourceUrl);
  if (host) return `site:${host} ${identity} ${suffix}`.trim();
  return `"${outlet}" ${reference} ${suffix}`.trim();
}

function parseSearchResults(text) {
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const titleMatch = lines[index].match(/^\d+\.\s+(.+)$/);
    if (!titleMatch) continue;
    const urlMatch = lines[index + 1]?.match(/^URL:\s*(.+)$/i);
    const snippetMatch = lines[index + 2]?.match(/^Snippet:\s*(.*)$/i);
    if (!urlMatch) continue;
    results.push({ title: titleMatch[1].trim(), url: urlMatch[1].trim(), snippet: snippetMatch?.[1]?.trim() || "" });
  }
  return results;
}

function emailAddresses(text) {
  const normalized = String(text || "")
    .replace(/\s*(?:\[at\]|\(at\))\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\))\s*/gi, ".");
  return [...new Set((normalized.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(normalizedEmail))];
}

function discoveryEmailScore(email) {
  const local = email.split("@")[0] || "";
  const preferred = /^(editor|editorial|press|news|tips|contact|hello|info|reviews?|submissions?)\b/i.test(local) ? 5 : 0;
  const rejected = /(?:advert|sales|sponsor|marketing|publishing|business|jobs?|careers?|support|privacy|legal|billing|webmaster|noreply|no-reply)/i.test(local) ? -100 : 0;
  return preferred + rejected;
}

function resultOutlet(result) {
  const host = sourceHost(result.url);
  if (/(^|\.)youtube\.com$/i.test(host)) {
    return clean(result.title).replace(/\s*[-|]\s*YouTube\s*$/i, "").trim() || host;
  }
  const label = host.split(".").slice(0, -1).join(".") || host;
  return label.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

function creatorSource(result) {
  return /(^|\.)youtube\.com$/i.test(sourceHost(result.url));
}

function discoveryResultAllowed(result, settings) {
  const value = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  if (!/^https?:\/\//i.test(result.url)) return false;
  if (/(facebook|instagram|linkedin|pinterest|x\.com|twitter|reddit)\.com/i.test(result.url)) return false;
  return !matchesAny(value, settings.excludePatterns || []);
}

function pageLooksEditorial(result, page, settings) {
  const text = `${result.title} ${result.snippet} ${page.text || ""}`.toLowerCase();
  const editorialSignals = settings.editorialPatterns || ["review", "editor", "journalist", "magazine", "news", "podcast", "coverage", "critic", "newsletter", "youtube"];
  const gameSignals = settings.gamePatterns || ["video game", "videogame", "gaming", "mobile game", "indie game", "android game", "iphone game", "puzzle game", "adventure game"];
  if (!matchesAny(text, editorialSignals) || !matchesAny(text, gameSignals)) return false;
  return !matchesAny(text, settings.pageExcludePatterns || []);
}

async function readDiscoveryState(chatId) {
  const file = path.join(getChatToolStateDir(chatId, toolName), "discovery-state.json");
  try {
    return { file, data: JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) };
  } catch {
    return { file, data: { cursor: 0, seenUrls: [] } };
  }
}

async function saveDiscoveryState(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `\uFEFF${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function nextDiscoveryQueries(settings, state) {
  const queries = settings.queries || [];
  if (!queries.length) return [];
  const count = Math.max(1, Math.min(Number(settings.queriesPerRun || 2), queries.length));
  return Array.from({ length: count }, (_, offset) => queries[(state.cursor + offset) % queries.length]);
}

async function discoverContacts(arisa, chatId, profile, allContacts, draftRecipients, needed) {
  const settings = profile.discovery;
  if (!settings?.enabled || needed < 1) return { queries: [], pagesOpened: 0, found: 0, added: [], skippedUsed: 0 };

  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const webTool = settings.webTool || profile.personalization?.webTool || "web-browser";
  const knownEmails = new Set([...allContacts.map((contact) => normalizedEmail(contact.email)), ...draftRecipients]);
  const usedOutlets = new Set(allContacts.filter((contact) => contact.status && contact.status !== (profile.contactStatus || "new")).map(outletKey).filter(Boolean));
  const { file, data: state } = await readDiscoveryState(chatId);
  const queries = nextDiscoveryQueries(settings, state);
  const seenUrls = new Set(state.seenUrls || []);
  const added = [];
  let pagesOpened = 0;
  let skippedUsed = 0;

  for (const query of queries) {
    if (added.length >= needed) break;
    let results = [];
    try {
      const search = await runTool(arisa, webTool, { mode: "search", maxResults: String(settings.maxResults || 6) }, Number(settings.timeoutMs || 90_000), query);
      results = parseSearchResults(search.text).filter((result) => discoveryResultAllowed(result, settings));
    } catch {
      continue;
    }

    for (const result of results) {
      if (added.length >= needed) break;
      const outlet = resultOutlet(result);
      const key = outletKey({ outlet });
      if (seenUrls.has(result.url) || (profile.selection?.skipOutletsAlreadyUsed !== false && usedOutlets.has(key))) {
        skippedUsed += 1;
        continue;
      }
      seenUrls.add(result.url);
      let page;
      try {
        page = await runTool(arisa, webTool, { mode: "open", url: result.url }, Number(settings.timeoutMs || 90_000));
        pagesOpened += 1;
      } catch {
        continue;
      }
      if (!pageLooksEditorial(result, page, settings)) continue;
      const emails = emailAddresses(`${result.snippet}\n${page.text || ""}`)
        .filter((email) => !knownEmails.has(email))
        .filter((email) => discoveryEmailScore(email) > 0 || (creatorSource(result) && discoveryEmailScore(email) > -100))
        .sort((a, b) => discoveryEmailScore(b) - discoveryEmailScore(a));
      const email = emails[0];
      if (!email) continue;

      try {
        const created = await runTool(arisa, campaignTool, {
          action: "add-contact",
          email,
          name: outlet,
          outlet,
          angle: settings.angle || "Independent and mobile game editorial coverage",
          referenceGame: result.title,
          personalNote: `${settings.personalNote || "Discovered from a public editorial/contact page."} Search: ${query}`,
          sourceUrl: result.url,
          verify: "true"
        });
        const contact = created.contact || { email, outlet };
        knownEmails.add(email);
        added.push({ email, outlet, sourceUrl: result.url });
        if (key) usedOutlets.add(key);
      } catch {}
    }
  }

  state.cursor = ((state.cursor || 0) + queries.length) % Math.max(1, (settings.queries || []).length);
  state.seenUrls = [...seenUrls].slice(-1000);
  state.updatedAt = new Date().toISOString();
  await saveDiscoveryState(file, state);
  return { queries, pagesOpened, found: added.length, added, skippedUsed };
}

function isUsableResearchResult(result, contact) {
  const url = String(result?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (/(contact|about|privacy|terms|advertis|presskit|submit|login|sign-in)/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const expectedHost = sourceHost(contact.sourceUrl).toLowerCase();
    if (expectedHost && host !== expectedHost && !host.endsWith(`.${expectedHost}`) && !expectedHost.endsWith(`.${host}`)) return false;
    if (parsed.pathname.replace(/\/+$/, "") === "" && !parsed.search) return false;
  } catch {
    return false;
  }
  const normalizedUrl = url.toLowerCase();
  const sourceUrl = clean(contact.sourceUrl).replace(/\/$/, "").toLowerCase();
  return !sourceUrl || normalizedUrl !== sourceUrl;
}

async function researchContact(arisa, profile, contact) {
  const settings = profile.personalization;
  if (!settings?.enabled) return null;
  const webTool = settings.webTool || "web-browser";
  const args = { mode: "search", maxResults: String(settings.maxResults || 5) };
  try {
    const output = await runTool(arisa, webTool, args, Number(settings.timeoutMs || 120_000), personalizationQuery(contact, settings));
    const result = parseSearchResults(output.text).find((item) => isUsableResearchResult(item, contact));
    return result || null;
  } catch {
    return null;
  }
}

function personalizedOpening(language, research, profile) {
  if (!research?.title || !research?.url) return "";
  const templates = profile.personalization?.openingTemplates || {};
  const template = templates[language] || templates[profile.defaultLanguage || "en"];
  if (!template) return "";
  const values = {
    title: research.title.replace(/[\r\n]+/g, " ").trim(),
    url: research.url.trim(),
    campaign: clean(profile.name)
  };
  return String(template).replace(/{{\s*(title|url|campaign)\s*}}/g, (_, key) => values[key]);
}

function replaceOpeningParagraph(body, opening) {
  if (!opening) return body;
  const paragraphs = String(body || "").split(/\r?\n\r?\n/);
  if (paragraphs.length < 2) return body;
  paragraphs[1] = opening;
  return paragraphs.join("\n\n");
}

async function runTool(arisa, name, args, timeoutMs = 120_000, text = "") {
  const request = { name, args };
  if (text) request.text = text;
  const result = await arisa.tools.run(request, { timeoutMs });
  if (!result.ok) throw new Error(result.error || `${name} failed`);
  if (result.output?.json !== undefined) return result.output.json;
  const outputText = result.output?.text || "";
  try {
    return JSON.parse(outputText || "{}");
  } catch {
    return { text: outputText };
  }
}

async function acquireRunLock(chatId) {
  const tmpDir = getChatToolTmpDir(chatId, toolName);
  const lockFile = path.join(tmpDir, "run.lock");
  await mkdir(tmpDir, { recursive: true });
  try {
    const handle = await open(lockFile, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return { tmpDir, lockFile };
  } catch (error) {
    if (error.code === "EEXIST") {
      try {
        const info = await stat(lockFile);
        if (Date.now() - info.mtimeMs > 30 * 60 * 1000) {
          await rm(lockFile, { force: true });
          return acquireRunLock(chatId);
        }
      } catch {}
      throw new Error("Another campaign draft batch is already running");
    }
    throw error;
  }
}

async function releaseRunLock(lock) {
  if (!lock) return;
  await rm(lock.lockFile, { force: true });
  try { await rm(lock.tmpDir, { recursive: false }); }
  catch {}
}

async function listContacts(arisa, profile) {
  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const data = await runTool(arisa, campaignTool, { action: "list-contacts", status: profile.contactStatus || "new", limit: "1000" });
  return data.contacts || [];
}

async function listAllContacts(arisa, profile) {
  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const data = await runTool(arisa, campaignTool, { action: "list-contacts", limit: "5000" });
  return data.contacts || [];
}

async function gmailDraftRecipients(arisa, profile) {
  const gmailTool = profile.gmailTool || defaults.GMAIL_TOOL;
  const data = await runTool(arisa, gmailTool, { action: "list-drafts", maxResults: "500" });
  return new Set((data.drafts || []).map((draft) => normalizedEmail(draft.to)).filter(Boolean));
}

function chooseContacts(allContacts, candidateContacts, draftRecipients, profile, limit) {
  const alreadyUsedOutlets = new Set();
  if (profile.selection?.skipOutletsAlreadyUsed !== false) {
    for (const contact of allContacts) {
      if (contact.status && contact.status !== (profile.contactStatus || "new")) {
        const key = outletKey(contact);
        if (key) alreadyUsedOutlets.add(key);
      }
    }
  }
  const chosenOutlets = new Set();
  return candidateContacts
    .filter((contact) => !draftRecipients.has(normalizedEmail(contact.email)))
    .filter((contact) => !alreadyUsedOutlets.has(outletKey(contact)))
    .filter((contact) => !contact.emailCheck || contact.emailCheck.deliverable === true)
    .filter((contact) => isSelectable(contact, profile))
    .sort((a, b) => scoreContact(b, profile) - scoreContact(a, profile) || clean(a.createdAt).localeCompare(clean(b.createdAt)))
    .filter((contact) => {
      if (profile.selection?.dedupeByOutlet === false) return true;
      const key = outletKey(contact);
      if (key && chosenOutlets.has(key)) return false;
      if (key) chosenOutlets.add(key);
      return true;
    })
    .slice(0, limit);
}

async function verifyContact(arisa, profile, contact) {
  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const data = await runTool(arisa, campaignTool, { action: "verify-email", email: contact.email });
  return data.check;
}

async function createDraft(arisa, profile, contact) {
  const language = detectLanguage(contact, profile);
  const template = profile.templates?.[language] || profile.templates?.[profile.defaultLanguage || "en"];
  if (!template) throw new Error(`No template found for language ${language}`);
  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const research = await researchContact(arisa, profile, contact);
  const subject = render(template.subject, contact, profile);
  const renderedBody = render(template.body, contact, profile);
  const body = replaceOpeningParagraph(renderedBody, personalizedOpening(language, research, profile));
  const data = await runTool(arisa, campaignTool, { action: "create-draft", email: contact.email, subject, body, type: profile.draftType || "first" });
  return {
    email: contact.email,
    outlet: contact.outlet,
    language,
    personalized: Boolean(research),
    referenceUrl: research?.url || null,
    draftId: data.draft?.id || null
  };
}

async function handleRun(request) {
  const args = request.args || {};
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const profile = await loadProfile(request.chatId, args.profile || config.DEFAULT_PROFILE);
  const arisa = createArisaClient({ toolName, chatId: request.chatId });

  if ((args.action || "run-batch") === "status") {
    const campaign = await runTool(arisa, profile.campaignTool || defaults.CAMPAIGN_TOOL, { action: "status" });
    const draftRecipients = await gmailDraftRecipients(arisa, profile);
    return { action: "status", profile: profile.name, campaign, gmailDrafts: draftRecipients.size };
  }

  const lock = await acquireRunLock(request.chatId);
  try {
    const limit = Math.max(1, Math.min(50, Number(args.limit || profile.limit || config.DEFAULT_LIMIT || 10)));
    const dryRun = truthy(args.dryRun);
    let allContacts = await listAllContacts(arisa, profile);
    let candidateContacts = await listContacts(arisa, profile);
    const draftRecipients = await gmailDraftRecipients(arisa, profile);
    const poolTarget = Math.max(limit, Number(profile.discovery?.minEligiblePool || limit));
    let eligiblePool = chooseContacts(allContacts, candidateContacts, draftRecipients, profile, poolTarget);
    let selected = eligiblePool.slice(0, limit);
    const discovery = await discoverContacts(arisa, request.chatId, profile, allContacts, draftRecipients, poolTarget - eligiblePool.length);
    if (discovery.found) {
      allContacts = await listAllContacts(arisa, profile);
      candidateContacts = await listContacts(arisa, profile);
      eligiblePool = chooseContacts(allContacts, candidateContacts, draftRecipients, profile, poolTarget);
      selected = eligiblePool.slice(0, limit);
    }
    const verified = [];
    const drafted = [];
    const skipped = [];

    for (const contact of selected) {
      try {
        const check = await verifyContact(arisa, profile, contact);
        verified.push({ email: contact.email, status: check.status, deliverable: check.deliverable });
        if (check.deliverable !== true) {
          skipped.push({ email: contact.email, reason: `verification ${check.status}` });
          continue;
        }
        if (!dryRun) drafted.push(await createDraft(arisa, profile, contact));
      } catch (error) {
        skipped.push({ email: contact.email, reason: error?.message || String(error) });
      }
    }

    return {
      action: "run-batch",
      profile: profile.name,
      dryRun,
      candidates: candidateContacts.length,
      eligiblePool: eligiblePool.length,
      poolTarget,
      discovery,
      selected: selected.map((contact) => ({ email: contact.email, outlet: contact.outlet, score: scoreContact(contact, profile), language: detectLanguage(contact, profile) })),
      verified: verified.length,
      drafted: drafted.length,
      sent: 0,
      drafts: drafted,
      skipped: skipped.slice(0, 20)
    };
  } finally {
    await releaseRunLock(lock);
  }
}

async function main() {
  const [command, flag, requestFile] = process.argv.slice(2);
  if (command === "--help" || command === "help" || !command) return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) throw new Error("Usage: node index.js run --request-file <json>");
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const output = await handleRun(request);
    console.log(JSON.stringify({ ok: true, output: { text: JSON.stringify(output, null, 2), json: output, mimeType: "application/json" } }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  }
}

main();
