import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  run-batch   Reconcile Gmail Sent, verify contacts selected by a profile, and create Gmail drafts only. args: profile?, limit?, dryRun?, untilDrafted?, retryDelaySeconds?, maxAttempts?, maxRuntimeSeconds?
  reconcile-sent Reconcile manually sent Gmail messages into campaign state. args: profile?
  status      Reconcile Gmail Sent and return campaign status and Gmail draft count. args: profile?

Profiles live under the chat-scoped state directory:
  <chatToolStateDir>/profiles/<profile>.json

Profiles may enable web research to cite relevant articles or videos in the opening paragraph.
When discovery.creativeDiscovery.enabled is true, zero-candidate runs automatically rotate through comparable titles, adjacent themes, audiences, and contact intents before returning no result.
The runner is generic. Campaign-specific copy, keywords, language detection, and tool names belong in the profile JSON.`);
}

function clean(value) { return String(value || "").trim(); }
function decodeHtmlEntities(value) {
  const named = { amp: "&", apos: "'", quot: "\"", lt: "<", gt: ">", nbsp: " " };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt|nbsp);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return named[lower] ?? match;
  });
}
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

function coverageSourceUrl(contact) {
  return clean(contact.coverageSourceUrl || contact.sourceUrl);
}

function contactSourceUrl(contact) {
  return clean(contact.contactSourceUrl);
}

function contactText(contact) {
  return `${contact.email || ""} ${contact.name || ""} ${contact.outlet || ""} ${contact.angle || ""} ${contact.referenceGame || ""} ${contact.coverageTitle || ""} ${contact.personalNote || ""} ${contact.groundedOpening || ""} ${contact.market || ""} ${coverageSourceUrl(contact)} ${contactSourceUrl(contact)}`.toLowerCase();
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
  const agentDecidesEligibility = profile.selection?.agentDecidesEligibility === true;
  if (!isPlausibleEmail(contact.email)) return false;
  if (profile.selection?.requireCoverageSourceProvenance === true && !coverageSourceUrl(contact)) return false;
  if (profile.selection?.requireContactSourceProvenance === true && !contactSourceUrl(contact)) return false;
  if (profile.selection?.requireGroundedOpening === true && !clean(contact.groundedOpening)) return false;
  const approvedCrossDomainEmails = (profile.selection?.approvedCrossDomainEmails || []).map(normalizedEmail);
  if (
    profile.selection?.requireSourceProvenance !== false
    && !approvedCrossDomainEmails.includes(normalizedEmail(contact.email))
    && !contactEmailFitsSource(contact)
  ) return false;
  if (!agentDecidesEligibility && include.length && !matchesAny(text, include)) return false;
  if (!agentDecidesEligibility && requiredKeywordGroups.some((patterns) => !matchesAny(text, patterns))) return false;
  if (exclude.length && matchesAny(text, exclude)) return false;
  if (allowedLanguages.length && !allowedLanguages.includes(detectLanguage(contact, profile))) return false;
  return true;
}

function detectLanguage(contact, profile) {
  const explicit = clean(contact.language || contact.preferredLanguage).toLowerCase();
  if (explicit) return explicit;
  const text = contactText(contact);
  for (const rule of profile.languageDetection || []) {
    if (new RegExp(rule.match, "i").test(text)) return rule.language;
  }
  return profile.defaultLanguage || "en";
}

function referenceOutlet(value) {
  return decodeHtmlEntities(clean(value))
    .replace(/\s*\(@[^)]+\)\s*(?:\/.*)?$/i, "")
    .replace(/\s*\/\s*(?:Posts?|Home)\s*\/\s*(?:X|Twitter)\s*$/i, "")
    .replace(/\s*[|–—-]\s*(?:X|Twitter)\s*$/i, "")
    .trim();
}

function emailOutlet(value) {
  const local = clean(value).split("@")[0].split("+")[0];
  const withoutRole = local.replace(/(?:colaboraciones|collaborations?|businessinquiries|business|contacto|contact|press|editorial|media|official|channel|youtube|reviews?)$/i, "");
  const readable = (withoutRole || local)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (readable.length < 2 || /^(?:info|hello|mail|team|admin)$/i.test(readable)) return "";
  return readable.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function looksLikeContentTitle(value) {
  const outlet = clean(value);
  return outlet.length > 55 || /#|\.{3}|\b(?:best|top)\s+\d*|[-|–—]\s*YouTube$/i.test(outlet);
}

function displayOutlet(contact) {
  const outlet = decodeHtmlEntities(clean(contact.outlet || contact.name));
  if (/^(?:x|twitter|posts?|home)$/i.test(outlet)) return referenceOutlet(contact.referenceGame) || emailOutlet(contact.email) || outlet;
  if (looksLikeContentTitle(outlet)) return emailOutlet(contact.email) || outlet;
  return outlet || emailOutlet(contact.email) || "there";
}

function render(template, contact, profile) {
  const outlet = displayOutlet(contact);
  const values = {
    outlet,
    name: outlet,
    email: clean(contact.email),
    referenceGame: clean(contact.referenceGame),
    personalNote: clean(contact.personalNote),
    coverageTitle: clean(contact.coverageTitle),
    groundedOpening: clean(contact.groundedOpening),
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
  const host = sourceHost(coverageSourceUrl(contact));
  if (host) return `site:${host} ${identity} ${suffix}`.trim();
  return `"${outlet}" ${reference} ${suffix}`.trim();
}

function parseSearchResults(text) {
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const titleMatch = lines[index].match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/);
    if (!titleMatch) continue;
    let url = "";
    const snippets = [];
    for (let offset = 1; offset <= 6 && index + offset < lines.length; offset += 1) {
      const line = lines[index + offset].trim();
      if (/^(?:\d+[.)]|[-*])\s+/.test(line)) break;
      const urlMatch = line.match(/^(?:URL|Link):\s*(https?:\/\/\S+)/i);
      const snippetMatch = line.match(/^(?:Snippet|Description):\s*(.*)$/i);
      if (urlMatch) url = urlMatch[1];
      else if (snippetMatch) snippets.push(snippetMatch[1]);
      else if (url && line && !/^[-=]+$/.test(line)) snippets.push(line);
    }
    if (url) results.push({ title: decodeHtmlEntities(titleMatch[1]).trim(), url: url.trim(), snippet: decodeHtmlEntities(snippets.join(" ")).trim() });
  }
  return [...new Map(results.map((result) => [result.url, result])).values()];
}

function emailAddresses(text) {
  const normalized = String(text || "")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*/gi, ".")
    .replace(/(?<=\w)\s+@\s+(?=\w)/g, "@")
    .replace(/(?<=\w)\s+\.\s+(?=\w)/g, ".")
    .replace(/^mailto:/gim, "");
  return [...new Set((normalized.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map((email) => normalizedEmail(email.replace(/[),.;:]+$/, ""))))];
}

function discoveryEmailScore(email) {
  const local = email.split("@")[0] || "";
  if (!local || /[＊*•…]/.test(local) || /(?:hidden|redacted|example|yourname|emailaddress)/i.test(local)) return -100;
  const preferred = /^(editor|editorial|press|news|tips|contact|hello|info|reviews?|submissions?)\b/i.test(local) ? 5 : 0;
  const rejected = /(?:advert|sales|sponsor|marketing|publishing|business|jobs?|careers?|support|privacy|legal|billing|webmaster|noreply|no-reply)/i.test(local) ? -100 : 0;
  return preferred + rejected;
}

function isPlausibleEmail(value) {
  const email = normalizedEmail(value);
  if (!/^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) return false;
  if (email.includes("..") || discoveryEmailScore(email) <= -100) return false;
  return emailAddresses(email).length === 1 && emailAddresses(email)[0] === email;
}

function contactEmailFitsSource(contact) {
  const email = normalizedEmail(contact.email);
  if (!isPlausibleEmail(email)) return false;
  const domain = email.split("@")[1] || "";
  const host = sourceHost(contactSourceUrl(contact) || coverageSourceUrl(contact));
  if (!domain || !host) return false;
  if (baseDomain(domain) === baseDomain(host)) return true;
  return /^(gmail|outlook|hotmail|yahoo|protonmail|icloud|gmx|mail)\./i.test(domain);
}

function baseDomain(host) {
  const parts = clean(host).toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const secondLevel = new Set(["co.uk", "com.au", "co.jp", "co.kr", "com.br", "com.mx", "co.nz"]);
  const tail2 = parts.slice(-2).join(".");
  return secondLevel.has(tail2) ? parts.slice(-3).join(".") : tail2;
}

function emailFitsSource(email, result, totalEmails) {
  if (discoveryEmailScore(email) <= -100) return false;
  const domain = email.split("@")[1] || "";
  const host = sourceHost(result.url);
  if (!domain || !host) return false;
  if (baseDomain(domain) === baseDomain(host)) return true;
  const freeMail = /^(gmail|outlook|hotmail|yahoo|protonmail|icloud|gmx|mail)\./i.test(domain);
  return freeMail && totalEmails === 1;
}

function resultOutlet(result) {
  const host = sourceHost(result.url);
  const title = decodeHtmlEntities(clean(result.title));
  if (/(^|\.)(x|twitter)\.com$/i.test(host)) {
    const titleOutlet = referenceOutlet(title);
    if (titleOutlet && !/^(?:x|twitter|posts?|home)$/i.test(titleOutlet)) return titleOutlet;
    try {
      const handle = decodeURIComponent(new URL(result.url).pathname.split("/").filter(Boolean)[0] || "");
      if (handle) return handle;
    } catch {}
  }
  if (/(^|\.)youtube\.com$/i.test(host)) {
    return title.replace(/\s*[-|]\s*YouTube\s*$/i, "").trim() || host;
  }
  if (/(^|\.)(spotify\.com|podcasts\.apple\.com|podbean\.com|spreaker\.com|buzzsprout\.com|anchor\.fm)$/i.test(host)) {
    const showName = title.split(/\s*[|–—]\s*/)[0].trim();
    if (showName && !/^(spotify|apple podcasts?|podcast)$/i.test(showName)) return showName;
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
  const activeEditorialSignals = creatorSource(result)
    ? editorialSignals
    : editorialSignals.filter((pattern) => !/^(youtube|twitch|channel|creator)$/i.test(pattern));
  const gameSignals = settings.gamePatterns || ["video game", "videogame", "gaming", "mobile game", "indie game", "android game", "iphone game", "puzzle game", "adventure game"];
  const requiredGroups = settings.pageRequiredKeywordGroups || [];
  if (!matchesAny(text, activeEditorialSignals) || !matchesAny(text, gameSignals)) return false;
  if (requiredGroups.some((patterns) => !matchesAny(text, patterns))) return false;
  return !matchesAny(text, settings.pageExcludePatterns || []);
}

function contactPageUrls(text, sourceUrl, limit = 2) {
  let source;
  try { source = new URL(sourceUrl); }
  catch { return []; }
  const urls = [];
  const matches = String(text || "").matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g);
  for (const match of matches) {
    try {
      const url = new URL(match[1], source);
      if (url.hostname.replace(/^www\./i, "") !== source.hostname.replace(/^www\./i, "")) continue;
      if (!/(contact|about|team|staff|editor|press|write-for-us|submit)/i.test(`${url.pathname}${url.search}`)) continue;
      if (!urls.includes(url.toString())) urls.push(url.toString());
      if (urls.length >= limit) break;
    } catch {}
  }
  return urls;
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
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `\uFEFF${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function stableHash(value) {
  let total = 2166136261;
  for (const character of String(value)) total = Math.imul(total ^ character.charCodeAt(0), 16777619) >>> 0;
  return total;
}

function uniqueSortedQueries(queries) {
  return [...new Set(queries.map(clean).filter(Boolean))].sort((a, b) => stableHash(a) - stableHash(b));
}

function queryCatalog(settings) {
  const queries = [...(settings.queries || [])];
  const templates = settings.queryTemplates || [];
  const markets = settings.markets || [];
  const audiences = settings.audiences || [""];
  const contacts = settings.contactIntents || [""];
  for (const market of markets) {
    const values = typeof market === "string" ? { market } : market;
    for (const template of templates) {
      for (const audience of audiences) {
        for (const contact of contacts) {
          const query = String(template)
            .replace(/{{\s*market\s*}}/g, clean(values.market || values.label))
            .replace(/{{\s*terms\s*}}/g, clean(values.terms || values.gameTerms))
            .replace(/{{\s*language\s*}}/g, clean(values.language))
            .replace(/{{\s*audience\s*}}/g, clean(audience))
            .replace(/{{\s*contact\s*}}/g, clean(contact))
            .replace(/\s+/g, " ")
            .trim();
          if (query) queries.push(query);
        }
      }
    }
  }
  return uniqueSortedQueries(queries);
}

function creativeQueryCatalog(settings) {
  const creative = settings.creativeDiscovery;
  if (creative?.enabled !== true) return [];
  const queries = [...(creative.queries || [])];
  const templates = creative.templates || [
    '"{{seed}}" review {{audience}} {{contact}}',
    '"{{seed}}" similar games {{audience}} {{contact}}',
    '{{theme}} games {{audience}} {{contact}}',
    'site:youtube.com "{{seed}}" business email'
  ];
  const seeds = creative.seeds || [];
  const themes = creative.themes || [];
  const audiences = creative.audiences || settings.audiences || ["reviewer"];
  const contacts = creative.contactIntents || settings.contactIntents || ["contact email"];
  const concepts = [
    ...seeds.map((seed) => ({ seed, theme: "" })),
    ...themes.map((theme) => ({ seed: "", theme }))
  ];
  for (const concept of concepts) {
    for (const template of templates) {
      if (template.includes("{{seed}}") && !concept.seed) continue;
      if (template.includes("{{theme}}") && !concept.theme) continue;
      for (const audience of audiences) {
        for (const contact of contacts) {
          const query = String(template)
            .replace(/{{\s*seed\s*}}/g, clean(concept.seed))
            .replace(/{{\s*theme\s*}}/g, clean(concept.theme))
            .replace(/{{\s*audience\s*}}/g, clean(audience))
            .replace(/{{\s*contact\s*}}/g, clean(contact))
            .replace(/\s+/g, " ")
            .trim();
          if (query) queries.push(query);
        }
      }
    }
  }
  return uniqueSortedQueries(queries);
}

function nextQueries(catalog, cursor, count) {
  if (!catalog.length) return [];
  const limit = Math.max(1, Math.min(Number(count || 2), catalog.length));
  return Array.from({ length: limit }, (_, offset) => catalog[(Number(cursor || 0) + offset) % catalog.length]);
}

function activeQueries(catalog, state) {
  const archived = state.archivedQueries || {};
  return catalog.filter((query) => !archived[query]);
}

function nextDiscoveryQueries(settings, state) {
  return nextQueries(activeQueries(queryCatalog(settings), state), state.cursor, settings.queryBudgetPerRun || settings.queriesPerRun || 2);
}

function nextCreativeQueries(settings, state) {
  const creative = settings.creativeDiscovery || {};
  return nextQueries(activeQueries(creativeQueryCatalog(settings), state), state.creativeCursor, creative.queryBudgetPerRun || settings.queryBudgetPerRun || 4);
}

function seenUrlRecently(seenUrls, url, cooldownDays) {
  const seenAt = seenUrls[url];
  if (!seenAt) return false;
  return Date.now() - new Date(seenAt).getTime() < cooldownDays * 24 * 60 * 60 * 1000;
}

function compactSeenUrls(seenUrls, limit = 3000) {
  return Object.fromEntries(Object.entries(seenUrls)
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, limit));
}

async function discoverContacts(arisa, chatId, profile, allContacts, draftRecipients, needed, options = {}) {
  const settings = profile.discovery;
  const dryRun = Boolean(options.dryRun);
  const emptyResult = { queries: [], searches: 0, pagesOpened: 0, found: 0, added: [], skippedUsed: 0, skippedSeen: 0, rejectedEmails: 0 };
  if (profile.selection?.agentDecidesEligibility === true) {
    return { ...emptyResult, skipped: "agent-review-required" };
  }
  if (!settings?.enabled || needed < 1) {
    return emptyResult;
  }

  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const webTool = settings.webTool || profile.personalization?.webTool || "web-browser";
  const knownEmails = new Set([...allContacts.map((contact) => normalizedEmail(contact.email)), ...draftRecipients]);
  const knownOutlets = new Set(allContacts.map(outletKey).filter(Boolean));
  const usedOutlets = new Set(allContacts.filter((contact) => contact.status && contact.status !== (profile.contactStatus || "new")).map(outletKey).filter(Boolean));
  const { file, data: state } = await readDiscoveryState(chatId);
  const creativeMode = options.mode === "creative";
  const creativeSettings = settings.creativeDiscovery || {};
  const catalog = activeQueries(creativeMode ? creativeQueryCatalog(settings) : queryCatalog(settings), state);
  const queries = creativeMode ? nextCreativeQueries(settings, state) : nextDiscoveryQueries(settings, state);
  const cursorKey = creativeMode ? "creativeCursor" : "cursor";
  const oldSeen = Array.isArray(state.seenUrls)
    ? Object.fromEntries(state.seenUrls.map((url) => [url, "1970-01-01T00:00:00.000Z"]))
    : (state.seenUrls || {});
  const seenUrls = { ...oldSeen };
  const cooldownDays = Math.max(1, Number((creativeMode ? creativeSettings.urlCooldownDays : null) || settings.urlCooldownDays || 45));
  const pageBudget = Math.max(1, Number((creativeMode ? creativeSettings.pageBudgetPerRun : null) || settings.pageBudgetPerRun || 30));
  const queryStats = state.queryStats || {};
  const archivedQueries = state.archivedQueries || {};
  const archivedThisRun = [];
  const added = [];
  let pagesOpened = 0;
  let searches = 0;
  let skippedUsed = 0;
  let skippedSeen = 0;
  let rejectedEmails = 0;

  for (const query of queries) {
    if (added.length >= needed || pagesOpened >= pageBudget) break;
    const stats = queryStats[query] || { runs: 0, results: 0, prospects: 0, errors: 0 };
    const prospectsBefore = Number(stats.prospects || 0);
    const errorsBefore = Number(stats.errors || 0);
    stats.runs += 1;
    stats.lastRunAt = new Date().toISOString();
    let results = [];
    try {
      const search = await runTool(arisa, webTool, { mode: "search", maxResults: String(settings.maxResults || 8) }, Number(settings.timeoutMs || 90_000), query);
      searches += 1;
      const rawResults = parseSearchResults(search.text);
      results = rawResults.filter((result) => discoveryResultAllowed(result, settings));
      stats.results += results.length;
    } catch (error) {
      stats.errors += 1;
      stats.lastError = clean(error?.message || error).slice(0, 300);
      queryStats[query] = stats;
      continue;
    }

    for (const result of results) {
      if (added.length >= needed || pagesOpened >= pageBudget) break;
      if (seenUrlRecently(seenUrls, result.url, cooldownDays)) {
        skippedSeen += 1;
        continue;
      }
      const outlet = resultOutlet(result);
      const key = outletKey({ outlet });
      if ((settings.dedupeAgainstAllOutlets !== false && knownOutlets.has(key)) ||
          (profile.selection?.skipOutletsAlreadyUsed !== false && usedOutlets.has(key))) {
        skippedUsed += 1;
        seenUrls[result.url] = new Date().toISOString();
        continue;
      }

      let page;
      try {
        page = await runTool(arisa, webTool, { mode: "open", url: result.url }, Number(settings.timeoutMs || 90_000));
        pagesOpened += 1;
        seenUrls[result.url] = new Date().toISOString();
      } catch (error) {
        stats.errors += 1;
        continue;
      }
      if (!pageLooksEditorial(result, page, settings)) continue;

      let pageText = page.text || "";
      if (!emailAddresses(`${result.snippet}\n${pageText}`).length) {
        for (const contactUrl of contactPageUrls(pageText, result.url, Number(settings.contactPagesPerResult || 3))) {
          if (pagesOpened >= pageBudget) break;
          if (seenUrlRecently(seenUrls, contactUrl, cooldownDays)) continue;
          try {
            const contactPage = await runTool(arisa, webTool, { mode: "open", url: contactUrl }, Number(settings.timeoutMs || 90_000));
            pagesOpened += 1;
            seenUrls[contactUrl] = new Date().toISOString();
            pageText += `\n${contactPage.text || ""}`;
          } catch {
            seenUrls[contactUrl] = new Date().toISOString();
          }
        }
      }

      const extractedEmails = emailAddresses(`${result.snippet}\n${pageText}`);
      const emails = extractedEmails
        .filter((email) => !knownEmails.has(email))
        .filter((email) => emailFitsSource(email, result, extractedEmails.length))
        .sort((a, b) => discoveryEmailScore(b) - discoveryEmailScore(a));
      let prospect = null;
      for (const email of emails) {
        try {
          const verification = await runTool(arisa, campaignTool, { action: "verify-email", email });
          if (verification.check?.deliverable !== true) {
            rejectedEmails += 1;
            continue;
          }
          prospect = { email, outlet, sourceUrl: result.url, query, verification: verification.check };
          break;
        } catch {
          rejectedEmails += 1;
        }
      }
      if (!prospect) continue;

      if (!dryRun) {
        try {
          await runTool(arisa, campaignTool, {
            action: "add-contact",
            email: prospect.email,
            name: outlet,
            outlet,
            angle: settings.angle || "Independent and mobile game editorial coverage",
            referenceGame: result.title,
            personalNote: `${settings.personalNote || "Discovered from a public editorial/contact page."} Search: ${query}`,
            sourceUrl: result.url,
            verify: "true"
          });
        } catch (error) {
          stats.errors += 1;
          continue;
        }
      }
      knownEmails.add(prospect.email);
      if (key) {
        knownOutlets.add(key);
        usedOutlets.add(key);
      }
      added.push({ email: prospect.email, outlet, sourceUrl: result.url, query, dryRun });
      stats.prospects += 1;
    }
    if (settings.archiveEmptyQueries !== false
        && Number(stats.prospects || 0) === prospectsBefore
        && Number(stats.errors || 0) === errorsBefore) {
      const archivedAt = new Date().toISOString();
      archivedQueries[query] = { archivedAt, reason: "no-eligible-prospect", mode: creativeMode ? "creative" : "standard" };
      stats.archivedAt = archivedAt;
      stats.archiveReason = "no-eligible-prospect";
      archivedThisRun.push(query);
    }
    queryStats[query] = stats;
  }

  if (!dryRun) {
    state[cursorKey] = (Number(state[cursorKey] || 0) + queries.length) % Math.max(1, catalog.length);
    state.seenUrls = compactSeenUrls(seenUrls, Number(settings.seenUrlLimit || 3000));
    state.queryStats = queryStats;
    state.archivedQueries = archivedQueries;
    state.runs = [...(state.runs || []), {
      at: new Date().toISOString(), mode: creativeMode ? "creative" : "standard",
      queries, searches, pagesOpened, found: added.length,
      skippedSeen, skippedUsed, rejectedEmails
    }].slice(-200);
    state.updatedAt = new Date().toISOString();
    await saveDiscoveryState(file, state);
  }
  return { mode: creativeMode ? "creative" : "standard", queries, searches, pagesOpened, found: added.length, added, skippedUsed, skippedSeen, rejectedEmails, archivedQueries: archivedThisRun, dryRun };
}
function researchTitleUsable(value) {
  const title = decodeHtmlEntities(value).replace(/[\r\n]+/g, " ").trim();
  const normalized = title
    .replace(/\s*[-|–—]\s*(YouTube|Spotify|Apple Podcasts?)\s*$/i, "")
    .replace(/^[\s\-–—|:：]+|[\s\-–—|:：]+$/g, "")
    .trim();
  if (normalized.length < 6) return false;
  return !/^(youtube|spotify|apple podcasts?|podcast|video|watch|home|untitled)$/i.test(normalized);
}

function isUsableResearchResult(result, contact) {
  const url = String(result?.url || "").trim();
  if (!researchTitleUsable(result?.title)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/(contact|about|privacy|terms|advertis|presskit|submit|login|sign-in)/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const expectedHost = sourceHost(coverageSourceUrl(contact)).toLowerCase();
    if (expectedHost && host !== expectedHost && !host.endsWith(`.${expectedHost}`) && !expectedHost.endsWith(`.${host}`)) return false;
    if (parsed.pathname.replace(/\/+$/, "") === "" && !parsed.search) return false;
  } catch {
    return false;
  }
  const normalizedUrl = url.toLowerCase();
  const sourceUrl = coverageSourceUrl(contact).replace(/\/$/, "").toLowerCase();
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
  if (!research?.url || !researchTitleUsable(research?.title)) return "";
  const personalization = profile.personalization || {};
  const templates = personalization.openingTemplates || {};
  const template = templates[language] || templates[profile.defaultLanguage || "en"];
  if (!template) return "";
  const values = {
    title: decodeHtmlEntities(research.title).replace(/[\r\n]+/g, " ").trim(),
    url: research.url.trim(),
    campaign: clean(profile.name)
  };
  const withoutSourceUrl = personalization.includeSourceUrl === true
    ? String(template)
    : String(template)
      .replace(/\s*[:：]\s*{{\s*url\s*}}/gi, "")
      .replace(/\s*{{\s*url\s*}}/gi, "");
  return withoutSourceUrl
    .replace(/{{\s*(title|url|campaign)\s*}}/g, (_, key) => values[key])
    .replace(/[ \t]+([,.!?;:，。！？；：])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function replaceOpeningParagraph(body, opening) {
  if (!opening) return body;
  const paragraphs = String(body || "").split(/\r?\n\r?\n/);
  if (paragraphs.length < 2) return body;
  paragraphs[1] = opening;
  return paragraphs.join("\n\n");
}

function exactCoverageResearch(contact) {
  const title = clean(contact.coverageTitle);
  const url = coverageSourceUrl(contact);
  return title && url ? { title, url, source: "contact" } : null;
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCanonicalUrls(body, canonicalUrls = {}) {
  let normalized = String(body || "");
  for (const [source, target] of Object.entries(canonicalUrls || {})) {
    const from = clean(source).replace(/\/$/, "");
    const to = clean(target);
    if (!from || !to) continue;
    normalized = normalized.replace(new RegExp(`${escapedRegExp(from)}(?!/)`, "g"), to);
  }
  return normalized;
}

function normalizedEvidenceText(value) {
  return decodeHtmlEntities(clean(value)).toLowerCase().replace(/[“”„«»「」『』'\"`]/g, "").replace(/\s+/g, " ");
}

function validateDraftContent({ contact, language, body, profile }) {
  const rules = profile.draftValidation || {};
  const failures = [];
  const normalizedBody = normalizedEvidenceText(body);
  const groundedOpening = normalizedEvidenceText(contact.groundedOpening);
  const coverageTitle = normalizedEvidenceText(contact.coverageTitle);
  if (rules.requireCoverageSource === true && !coverageSourceUrl(contact)) failures.push("missing coverage source URL");
  if (rules.requireContactSource === true && !contactSourceUrl(contact)) failures.push("missing public contact source URL");
  if (rules.requireGroundedOpening === true && !groundedOpening) failures.push("missing grounded opening");
  if (groundedOpening && !normalizedBody.includes(groundedOpening)) failures.push("grounded opening was not rendered");
  if (rules.requireCoverageTitle === true && !coverageTitle) failures.push("missing exact coverage title");
  if (coverageTitle && !normalizedBody.includes(coverageTitle)) failures.push("exact coverage title was not rendered");
  const explicitLanguage = clean(contact.language || contact.preferredLanguage).toLowerCase();
  if (explicitLanguage && explicitLanguage !== language) failures.push(`language mismatch: expected ${explicitLanguage}, got ${language}`);
  if (failures.length) throw new Error(`Draft preflight failed: ${failures.join("; ")}`);
  return true;
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
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
    return { tmpDir, lockFile };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let ownerAlive = true;
    try {
      const raw = await readFile(lockFile, "utf8");
      const parsed = raw.trim().startsWith("{") ? JSON.parse(raw) : { pid: Number(raw.trim()) };
      if (!Number.isInteger(parsed.pid) || parsed.pid < 2) ownerAlive = false;
      else process.kill(parsed.pid, 0);
    } catch (lockError) {
      if (lockError?.code === "EPERM") ownerAlive = true;
      else ownerAlive = false;
    }
    if (!ownerAlive) {
      await rm(lockFile, { force: true });
      return acquireRunLock(chatId);
    }
    throw new Error("Another campaign draft batch is already running");
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
  const data = await runTool(arisa, gmailTool, { action: "list-drafts", maxResults: "5000" });
  const recipients = new Set();
  for (const draft of data.drafts || []) {
    const parsed = emailAddresses(draft.to || "");
    if (parsed.length) parsed.forEach((email) => recipients.add(email));
    else if (clean(draft.to).includes("@")) recipients.add(normalizedEmail(draft.to));
  }
  return recipients;
}

async function readSentSyncState(chatId) {
  const file = path.join(getChatToolStateDir(chatId, toolName), "sent-sync.json");
  try {
    return { file, data: JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) };
  } catch {
    return { file, data: { version: 1, seenMessageIds: [], latestInternalDate: 0 } };
  }
}

async function reconcileSentMessages(arisa, chatId, profile) {
  const settings = profile.sentReconciliation || {};
  if (settings.enabled === false) return { enabled: false, observed: 0, matched: 0, added: 0 };
  const { file, data: state } = await readSentSyncState(chatId);
  const seen = new Set(state.seenMessageIds || []);
  const baseQuery = clean(settings.query || `in:sent "${clean(profile.name).replace(/-/g, " ")}"`);
  const after = Number(state.latestInternalDate || 0);
  const query = after ? `${baseQuery} after:${Math.floor(after / 1000)}` : baseQuery;
  const gmailTool = profile.gmailTool || defaults.GMAIL_TOOL;
  const campaignTool = profile.campaignTool || defaults.CAMPAIGN_TOOL;
  const sent = await runTool(arisa, gmailTool, {
    action: "list-sent",
    q: query,
    maxResults: String(after ? Number(settings.incrementalMaxResults || 500) : Number(settings.initialMaxResults || 2000)),
    maxPages: String(settings.maxPages || 10),
    concurrency: String(settings.concurrency || 10)
  }, Number(settings.timeoutMs || 300_000));
  const messages = sent.messages || [];
  const records = [];
  let latestInternalDate = after;
  for (const message of messages) {
    const id = clean(message.id);
    latestInternalDate = Math.max(latestInternalDate, Number(message.internalDate || 0));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const sentAt = Number(message.internalDate || 0)
      ? new Date(Number(message.internalDate)).toISOString()
      : clean(message.date);
    for (const email of emailAddresses(message.to || "")) {
      records.push({
        email,
        subject: clean(message.subject),
        type: "first",
        sentAt,
        sourceMessageId: id
      });
    }
  }
  let reconciliation = { observed: records.length, matched: 0, added: 0, ignored: 0 };
  if (records.length) {
    reconciliation = await runTool(arisa, campaignTool, { action: "record-sent-batch", records }, Number(settings.timeoutMs || 300_000));
  }
  state.version = 1;
  state.query = baseQuery;
  state.latestInternalDate = latestInternalDate;
  state.seenMessageIds = [...seen].slice(-5000);
  state.lastSyncAt = new Date().toISOString();
  state.lastResult = { messages: messages.length, ...reconciliation };
  await saveDiscoveryState(file, state);
  return { enabled: true, query, messages: messages.length, ...reconciliation };
}

function chooseContacts(allContacts, candidateContacts, draftRecipients, profile, limit, excludedEmails = new Set()) {
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
  const chosenEmails = new Set();
  return candidateContacts
    .filter((contact) => !draftRecipients.has(normalizedEmail(contact.email)))
    .filter((contact) => !excludedEmails.has(normalizedEmail(contact.email)))
    .filter((contact) => {
      const email = normalizedEmail(contact.email);
      if (!email || chosenEmails.has(email)) return false;
      chosenEmails.add(email);
      return true;
    })
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
  const research = exactCoverageResearch(contact) || await researchContact(arisa, profile, contact);
  const subject = decodeHtmlEntities(render(template.subject, contact, profile));
  const renderedBody = decodeHtmlEntities(render(template.body, contact, profile));
  const opening = clean(contact.groundedOpening) || personalizedOpening(language, research, profile);
  const body = normalizeCanonicalUrls(
    decodeHtmlEntities(replaceOpeningParagraph(renderedBody, opening)),
    profile.draftValidation?.canonicalUrls
  );
  validateDraftContent({ contact, language, body, profile });
  const data = await runTool(arisa, campaignTool, { action: "create-draft", email: contact.email, subject, body, type: profile.draftType || "first" });
  return {
    email: contact.email,
    outlet: contact.outlet,
    language,
    personalized: Boolean(opening),
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
    const sentReconciliation = await reconcileSentMessages(arisa, request.chatId, profile);
    const campaign = await runTool(arisa, profile.campaignTool || defaults.CAMPAIGN_TOOL, { action: "status" });
    const draftRecipients = await gmailDraftRecipients(arisa, profile);
    return { action: "status", profile: profile.name, campaign, gmailDrafts: draftRecipients.size, sentReconciliation };
  }

  if (args.action === "reconcile-sent") {
    const sentReconciliation = await reconcileSentMessages(arisa, request.chatId, profile);
    const campaign = await runTool(arisa, profile.campaignTool || defaults.CAMPAIGN_TOOL, { action: "status" });
    return { action: "reconcile-sent", profile: profile.name, campaign, sentReconciliation };
  }

  const lock = await acquireRunLock(request.chatId);
  try {
    const limit = Math.max(1, Math.min(10, Number(args.limit || profile.limit || config.DEFAULT_LIMIT || 1)));
    const dryRun = truthy(args.dryRun);
    const excludedEmails = new Set((args._excludedEmails || []).map(normalizedEmail));
    const sentReconciliation = dryRun
      ? { enabled: profile.sentReconciliation?.enabled !== false, skipped: "dry-run" }
      : await reconcileSentMessages(arisa, request.chatId, profile);
    let allContacts = await listAllContacts(arisa, profile);
    let candidateContacts = await listContacts(arisa, profile);
    const draftRecipients = await gmailDraftRecipients(arisa, profile);
    const poolTarget = Math.max(limit, Number(profile.discovery?.minEligiblePool || limit));
    const candidatesPerDraft = Math.max(1, Number(profile.candidatesPerDraft || 6));
    let eligiblePool = chooseContacts(allContacts, candidateContacts, draftRecipients, profile, poolTarget, excludedEmails);
    const discovery = await discoverContacts(
      arisa, request.chatId, profile, allContacts, draftRecipients,
      Math.max(0, poolTarget - eligiblePool.length), { dryRun, mode: "standard" }
    );
    if (discovery.found && !dryRun) {
      allContacts = await listAllContacts(arisa, profile);
      candidateContacts = await listContacts(arisa, profile);
      eligiblePool = chooseContacts(allContacts, candidateContacts, draftRecipients, profile, poolTarget, excludedEmails);
    }

    let creativeDiscovery = null;
    if (eligiblePool.length === 0 && profile.discovery?.creativeDiscovery?.enabled === true) {
      creativeDiscovery = await discoverContacts(
        arisa, request.chatId, profile, allContacts, draftRecipients,
        poolTarget, { dryRun, mode: "creative" }
      );
      if (creativeDiscovery.found && !dryRun) {
        allContacts = await listAllContacts(arisa, profile);
        candidateContacts = await listContacts(arisa, profile);
        eligiblePool = chooseContacts(allContacts, candidateContacts, draftRecipients, profile, poolTarget, excludedEmails);
      }
    }
    const selected = eligiblePool.slice(0, Math.min(eligiblePool.length, limit * candidatesPerDraft));
    const verified = [];
    const drafted = [];
    const skipped = [];

    for (const contact of selected) {
      if (drafted.length >= limit) break;
      try {
        const check = await verifyContact(arisa, profile, contact);
        verified.push({ email: contact.email, status: check.status, deliverable: check.deliverable });
        if (check.deliverable !== true) {
          skipped.push({ email: contact.email, reason: `verification ${check.status}` });
          continue;
        }
        if (!dryRun) {
          const latestDraftRecipients = await gmailDraftRecipients(arisa, profile);
          if (latestDraftRecipients.has(normalizedEmail(contact.email))) {
            skipped.push({ email: contact.email, reason: "already present in Gmail drafts" });
            continue;
          }
          drafted.push(await createDraft(arisa, profile, contact));
        }
      } catch (error) {
        skipped.push({ email: contact.email, reason: error?.message || String(error) });
      }
    }

    return {
      action: "run-batch",
      profile: profile.name,
      dryRun,
      sentReconciliation,
      candidates: candidateContacts.length,
      eligiblePool: eligiblePool.length,
      poolTarget,
      discovery,
      creativeDiscovery,
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRequest(request) {
  if (!truthy(request.args?.untilDrafted) || request.args?.action === "status" || truthy(request.args?.dryRun)) {
    return handleRun(request);
  }
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, Math.min(10, Number(request.args?.maxAttempts || 3)));
  const maxRuntimeMs = Math.max(30_000, Math.min(9 * 60_000, Number(request.args?.maxRuntimeSeconds || 480) * 1000));
  const excludedEmails = new Set((request.args?._excludedEmails || []).map(normalizedEmail));
  let lastOutput = null;
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const attemptRequest = { ...request, args: { ...(request.args || {}), _excludedEmails: [...excludedEmails] } };
    lastOutput = await handleRun(attemptRequest);
    if (lastOutput.drafted > 0) return { ...lastOutput, attempts, exhausted: false, elapsedMs: Date.now() - startedAt };
    const discoveryEmpty = lastOutput.eligiblePool === 0
      && Number(lastOutput.discovery?.found || 0) === 0
      && Number(lastOutput.creativeDiscovery?.found || 0) === 0;
    if (discoveryEmpty) {
      return { ...lastOutput, attempts, exhausted: true, stopReason: "discovery-empty", elapsedMs: Date.now() - startedAt };
    }
    for (const item of lastOutput.skipped || []) {
      if (item.email) excludedEmails.add(normalizedEmail(item.email));
    }
    const delayMs = Math.max(5_000, Math.min(60_000, Number(request.args?.retryDelaySeconds || 15) * 1000));
    if (attempts >= maxAttempts || Date.now() - startedAt + delayMs >= maxRuntimeMs) {
      return { ...lastOutput, attempts, exhausted: true, elapsedMs: Date.now() - startedAt };
    }
    await wait(delayMs);
  }
  return { ...(lastOutput || {}), attempts: maxAttempts, exhausted: true, elapsedMs: Date.now() - startedAt };
}
async function main() {
  const [command, flag, requestFile] = process.argv.slice(2);
  if (command === "--help" || command === "help" || !command) return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) throw new Error("Usage: node index.js run --request-file <json>");
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const output = await runRequest(request);
    console.log(JSON.stringify({ ok: true, output: { text: JSON.stringify(output, null, 2), json: output, mimeType: "application/json" } }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();

export { discoverContacts, isSelectable, normalizeCanonicalUrls, validateDraftContent };
