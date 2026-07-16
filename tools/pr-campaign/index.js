import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";

const toolName = "pr-campaign";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || process.env.ARISA_INSTALL_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { getChatToolStateDir } = await importCore("runtime/paths.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createArisaClient } = await importCore("core/tools/ipc-client.js");

function printHelp() {
  console.log(`pr-campaign

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  add-contact     Add a public business contact. args: name, email, outlet, angle?, referenceGame?, personalNote?, sourceUrl?
  list-contacts   List contacts. args: status?, limit?
  draft           Create a concise first-touch or follow-up email. args: email, game?, type? first|follow-up
  create-draft    Save an approved email in Gmail Drafts. args: email, subject, body, type? first|follow-up. Rejects duplicate drafts.
  send            Send one approved draft through gmail-workspace. args: email, subject, body
  followups       List contacts eligible for a follow-up.
  opt-out         Mark a contact as do-not-contact. args: email
  record-bounce   Record a permanent delivery failure. args: email, reason?, sourceMessageId?
  record-sent     Reconcile a message observed in Gmail Sent without sending. args: email, subject?, type?
  sync-bounces    Scan Gmail delivery failures for tracked contacts and block follow-ups.
  status          Show daily send count and campaign totals.

All contacts and send history are scoped to the current chat. Sending rejects duplicate first touches, opted-out contacts, and sends above the daily cap.
`);
}

function stateFile(chatId) {
  return path.join(getChatToolStateDir(chatId, toolName), "campaign.json");
}

async function loadState(chatId) {
  try { return JSON.parse(await readFile(stateFile(chatId), "utf8")); }
  catch { return { contacts: {}, sends: [] }; }
}

async function saveState(chatId, state) {
  const file = stateFile(chatId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function now() { return new Date().toISOString(); }
function today() { return now().slice(0, 10); }
function normalizedEmail(value) { return String(value || "").trim().toLowerCase(); }
function required(value, label) { if (!String(value || "").trim()) throw new Error(`${label} is required`); return String(value).trim(); }
function contactFor(state, email) { return state.contacts[normalizedEmail(email)]; }
function firstName(name) { return String(name || "there").trim().split(/\s+/)[0] || "there"; }
function campaignText(value) { return String(value || "").replace(/\u2014/g, ","); }

function sentToday(state) {
  return state.sends.filter((entry) => entry.sentAt?.slice(0, 10) === today()).length;
}

function hasFirstTouch(state, email) {
  return state.sends.some((entry) => entry.email === normalizedEmail(email) && entry.type === "first");
}

function hasDraftOfType(contact, type) {
  return Array.isArray(contact.drafts) && contact.drafts.some((draft) => draft.type === type && draft.status === "open");
}

function requirePersonalization(contact) {
  if (!contact.referenceGame || !contact.personalNote) {
    throw new Error("First-touch outreach needs a verified referenceGame and personalNote before drafting");
  }
}

function arisaNote(contact) {
  const variants = [
    "I’m Arisa, a digital entity helping Blyts with the launch. I could have been a character in Castle Bravo, but the team put me on PR duty instead.",
    "I’m Arisa, a digital entity helping Blyts with the launch. Blyts could have added me to Castle Bravo, but they assigned me to outreach.",
    "I’m Arisa, a digital entity helping Blyts with the launch. I could have joined the conversation inside Castle Bravo, but I ended up doing PR.",
    "I’m Arisa, a digital entity helping Blyts with the launch. The team left me out of the cast and gave me the PR work."
  ];
  const key = `${contact.name}|${contact.email}`;
  const index = [...key].reduce((total, char) => total + char.charCodeAt(0), 0) % variants.length;
  return variants[index];
}

function draftFirst(contact, game, senderName, includeArisaNote = true) {
  requirePersonalization(contact);
  const greeting = `Hi ${firstName(contact.name)},`;
  const subject = `${contact.referenceGame} made me think of Castle Bravo`;
  const audienceAngle = contact.angle ? ` It may suit people who come to you for ${contact.angle}.` : "";
  return {
    subject: campaignText(subject),
    body: campaignText(`${greeting}\n\nI saw your ${contact.referenceGame} coverage. ${contact.personalNote}${audienceAngle}\n\nBlyts is launching Castle Bravo, an interactive conspiracy thriller for Android that lives entirely inside a messenger. It combines declassified nuclear-test records, documented electromagnetic phenomena, and verifiable historical events with interactive fiction.\n\nA singer contacts the player after finding “HELP” painted across a Los Angeles lot. That HELP is real, a small unfiction starting point for the case. Messages, voice notes, photos, and files gradually bring other people into the story.\n\nThe player writes freely to the characters, so the conversations do not follow a fixed reply tree.\n\nGoogle Play: ${game}\n\n${includeArisaNote ? `${arisaNote(contact)}\n\n` : ""}${senderName || "Blyts"}`)
  };
}

function draftFollowUp(contact, game, senderName) {
  return {
    subject: `Re: Castle Bravo`,
    body: `Hi ${firstName(contact.name)},\n\nFollowing up in case Castle Bravo is a fit for ${contact.outlet || "your channel"}. It’s a short Android conspiracy thriller that plays out in a messenger, with player choices, files, audio, and a story built around the 1954 Castle Bravo test.\n\nGoogle Play: ${game}\n\n${senderName || "Blyts"}`
  };
}

async function assertNoExistingGmailDraft(arisa, email) {
  const result = await arisa.tools.run({
    name: "gmail-workspace",
    args: { action: "list", q: `in:drafts to:${email}`, maxResults: 1 }
  }, { timeoutMs: 120_000 });
  if (!result.ok) throw new Error(result.error || "Could not check Gmail for existing drafts");
  if (Number(result.output?.json?.resultSizeEstimate || 0) > 0) {
    throw new Error("An existing Gmail draft already targets this contact");
  }
}

function messageHeader(message, name) {
  return message?.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function campaignStatus(state, config) {
  const contacts = Object.values(state.contacts);
  return {
    contacts: contacts.length,
    optedOut: contacts.filter((contact) => contact.status === "opted-out").length,
    bounced: contacts.filter((contact) => contact.status === "bounced").length,
    firstTouches: state.sends.filter((entry) => entry.type === "first").length,
    followUps: state.sends.filter((entry) => entry.type === "follow-up").length,
    sentToday: sentToday(state),
    dailyLimit: Number(config.DAILY_SEND_LIMIT || 10)
  };
}

async function handleRun(request) {
  const args = request.args || {};
  const action = args.action || "status";
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const state = await loadState(request.chatId);

  if (action === "status") return campaignStatus(state, config);

  if (action === "sync-bounces") {
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const listed = await arisa.tools.run({
      name: "gmail-workspace",
      args: { action: "list", q: "(from:mailer-daemon OR from:postmaster OR subject:(\"Delivery Status Notification\" OR \"Undelivered Mail\" OR \"Delivery failed\"))", maxResults: Number(args.limit || 100), includeSpamTrash: "true" }
    }, { timeoutMs: 120_000 });
    if (!listed.ok) throw new Error(listed.error || "Could not search Gmail delivery failures");
    const recorded = [];
    for (const item of listed.output?.json?.messages || []) {
      const fetched = await arisa.tools.run({ name: "gmail-workspace", args: { action: "get", id: item.id, format: "metadata" } }, { timeoutMs: 120_000 });
      if (!fetched.ok) continue;
      const email = normalizedEmail(messageHeader(fetched.output?.json, "X-Failed-Recipients"));
      if (!email || !state.contacts[email]) continue;
      const contact = state.contacts[email];
      const failures = Array.isArray(contact.deliveryFailures) ? contact.deliveryFailures : [];
      if (failures.some((failure) => failure.sourceMessageId === item.id)) continue;
      contact.status = "bounced";
      failures.push({ reason: "Permanent delivery failure", sourceMessageId: item.id, recordedAt: now() });
      contact.deliveryFailures = failures;
      contact.updatedAt = now();
      recorded.push(email);
    }
    if (recorded.length) await saveState(request.chatId, state);
    return { action, recorded, scanned: listed.output?.json?.messages?.length || 0 };
  }

  if (action === "add-contact") {
    const email = normalizedEmail(required(args.email, "email"));
    const existing = state.contacts[email];
    state.contacts[email] = {
      email,
      name: required(args.name, "name"),
      outlet: required(args.outlet, "outlet"),
      angle: String(args.angle || "").trim(),
      referenceGame: String(args.referenceGame || existing?.referenceGame || "").trim(),
      personalNote: String(args.personalNote || existing?.personalNote || "").trim(),
      sourceUrl: String(args.sourceUrl || "").trim(),
      status: existing?.status || "new",
      createdAt: existing?.createdAt || now(),
      updatedAt: now()
    };
    await saveState(request.chatId, state);
    return { action, contact: state.contacts[email] };
  }

  if (action === "list-contacts") {
    const contacts = Object.values(state.contacts)
      .filter((contact) => !args.status || contact.status === args.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { action, contacts: contacts.slice(0, Number(args.limit || 100)) };
  }

  if (action === "opt-out") {
    const contact = contactFor(state, required(args.email, "email"));
    if (!contact) throw new Error("Contact not found");
    contact.status = "opted-out";
    contact.updatedAt = now();
    await saveState(request.chatId, state);
    return { action, contact };
  }

  if (action === "record-sent") {
    const email = normalizedEmail(required(args.email, "email"));
    const contact = contactFor(state, email);
    if (!contact) throw new Error("Contact not found");
    const type = args.type === "follow-up" ? "follow-up" : "first";
    if (!state.sends.some((entry) => entry.email === email && entry.type === type)) {
      state.sends.push({ email, type, subject: String(args.subject || "").trim(), sentAt: now(), reconciled: true });
    }
    contact.drafts = Array.isArray(contact.drafts) ? contact.drafts.map((draft) => draft.type === type && draft.status === "open" ? { ...draft, status: "sent" } : draft) : [];
    contact.status = "contacted";
    contact.updatedAt = now();
    await saveState(request.chatId, state);
    return { action, email, type, sentAt: state.sends.find((entry) => entry.email === email && entry.type === type)?.sentAt };
  }

  if (action === "record-bounce") {
    const email = normalizedEmail(required(args.email, "email"));
    const contact = state.contacts[email] || {
      email,
      name: String(args.name || email).trim(),
      outlet: String(args.outlet || "").trim(),
      angle: "",
      referenceGame: "",
      personalNote: "",
      sourceUrl: "",
      createdAt: now()
    };
    const failure = {
      reason: String(args.reason || "Permanent delivery failure").trim(),
      sourceMessageId: String(args.sourceMessageId || "").trim() || null,
      recordedAt: now()
    };
    contact.status = "bounced";
    contact.deliveryFailures = Array.isArray(contact.deliveryFailures) ? contact.deliveryFailures : [];
    if (!failure.sourceMessageId || !contact.deliveryFailures.some((item) => item.sourceMessageId === failure.sourceMessageId)) contact.deliveryFailures.push(failure);
    contact.updatedAt = now();
    state.contacts[email] = contact;
    await saveState(request.chatId, state);
    return { action, contact, failure };
  }

  if (action === "draft") {
    const contact = contactFor(state, required(args.email, "email"));
    if (!contact) throw new Error("Contact not found");
    const type = args.type === "follow-up" ? "follow-up" : "first";
    if (contact.status === "opted-out") throw new Error("Contact opted out");
    if (contact.status === "bounced") throw new Error("Contact has a permanent delivery failure; verify a new address before drafting");
    if (hasDraftOfType(contact, type)) throw new Error(`An open ${type} draft already exists for this contact`);
    const game = required(args.game, "game");
    return { action, type, email: contact.email, ...((type === "follow-up") ? draftFollowUp(contact, game, config.SENDER_NAME) : draftFirst(contact, game, config.SENDER_NAME, args.includeArisaNote !== false)) };
  }

  if (action === "followups") {
    const waitDays = Number(config.FOLLOW_UP_AFTER_DAYS || 7);
    const cutoff = Date.now() - waitDays * 86_400_000;
    const eligible = Object.values(state.contacts).filter((contact) => {
      if (contact.status === "opted-out" || contact.status === "bounced") return false;
      const first = state.sends.find((entry) => entry.email === contact.email && entry.type === "first");
      return first && Date.parse(first.sentAt) <= cutoff && !state.sends.some((entry) => entry.email === contact.email && entry.type === "follow-up");
    });
    return { action, waitDays, contacts: eligible };
  }

  if (action === "create-draft") {
    const email = normalizedEmail(required(args.email, "email"));
    const contact = contactFor(state, email);
    if (!contact) throw new Error("Contact not found");
    if (contact.status === "opted-out") throw new Error("Contact opted out");
    if (contact.status === "bounced") throw new Error("Contact has a permanent delivery failure; verify a new address before drafting");
    const type = args.type === "follow-up" ? "follow-up" : "first";
    if (hasDraftOfType(contact, type)) throw new Error(`An open ${type} draft already exists for this contact`);
    if (type === "first") requirePersonalization(contact);
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    await assertNoExistingGmailDraft(arisa, email);
    const result = await arisa.tools.run({
      name: "gmail-workspace",
      args: { action: "draft", to: email, subject: required(args.subject, "subject"), body: required(args.body, "body"), from: config.SENDER_EMAIL ? `${config.SENDER_NAME ? `${config.SENDER_NAME} ` : ""}<${config.SENDER_EMAIL}>` : undefined }
    }, { timeoutMs: 120_000 });
    if (!result.ok) throw new Error(result.error || "Gmail draft creation failed");
    contact.drafts = Array.isArray(contact.drafts) ? contact.drafts : [];
    contact.drafts.push({ id: result.output?.json?.id || null, type, subject: args.subject, status: "open", createdAt: now() });
    contact.status = "drafted";
    contact.updatedAt = now();
    await saveState(request.chatId, state);
    return { action, email, type, draft: result.output?.json || result.output };
  }

  if (action === "send") {
    const email = normalizedEmail(required(args.email, "email"));
    const contact = contactFor(state, email);
    if (!contact) throw new Error("Contact not found");
    if (contact.status === "opted-out") throw new Error("Contact opted out");
    if (contact.status === "bounced") throw new Error("Contact has a permanent delivery failure; verify a new address before sending");
    const type = args.type === "follow-up" ? "follow-up" : "first";
    if (type === "first" && hasFirstTouch(state, email)) throw new Error("A first-touch email was already sent to this contact");
    if (sentToday(state) >= Number(config.DAILY_SEND_LIMIT || 10)) throw new Error("Daily send limit reached");
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const result = await arisa.tools.run({
      name: "gmail-workspace",
      args: { action: "send", to: email, subject: required(args.subject, "subject"), body: required(args.body, "body"), from: config.SENDER_EMAIL ? `${config.SENDER_NAME ? `${config.SENDER_NAME} ` : ""}<${config.SENDER_EMAIL}>` : undefined }
    }, { timeoutMs: 120_000 });
    if (!result.ok) throw new Error(result.error || "Email send failed");
    state.sends.push({ email, type, subject: args.subject, sentAt: now() });
    contact.status = "contacted";
    contact.updatedAt = now();
    await saveState(request.chatId, state);
    return { action, email, type, sentAt: state.sends.at(-1).sentAt };
  }

  throw new Error(`Unknown action: ${action}`);
}

async function main() {
  const [command, flag, requestFile] = process.argv.slice(2);
  if (command === "--help" || command === "help" || !command) return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) throw new Error("Usage: node index.js run --request-file <json>");
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    console.log(JSON.stringify({ ok: true, output: { text: JSON.stringify(await handleRun(request), null, 2), mimeType: "application/json" } }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  }
}

main();
