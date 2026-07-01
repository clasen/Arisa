import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const bundledSkillDir = path.join(toolDir, "skill");
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");

const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);

function printHelp() {
  console.log(`stop-slop-writer

Usage:
  node index.js --help
  node index.js run --request-file <json>

Purpose:
  Load and apply bundled stop-slop skill assets. Returns the skill instructions,
  linked references, and deterministic slop flags for any supplied draft.

Input:
  request.text or artifact.text: brief or draft text
  args.mode: "brief" | "audit" | "both" (default: both)
  args.skillDir: optional local stop-slop skill directory containing SKILL.md
`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractQuotedPhrases(markdown) {
  const phrases = new Set();
  for (const match of markdown.matchAll(/"([^"]{3,120})"/g)) {
    const phrase = match[1].trim();
    if (!phrase.includes("[") && !phrase.includes("...") && /[a-zA-Z]/.test(phrase)) phrases.add(phrase);
  }
  return [...phrases];
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function getProvidedSkill(request) {
  const skills = Array.isArray(request.skills) ? request.skills : [];
  return skills.find((item) => item.name === "stop-slop" && item.content);
}

async function readReferences(skillDir) {
  return {
    phrases: await readFile(path.join(skillDir, "references", "phrases.md"), "utf8"),
    structures: await readFile(path.join(skillDir, "references", "structures.md"), "utf8"),
    examples: await readFile(path.join(skillDir, "references", "examples.md"), "utf8")
  };
}

async function resolveSkillAssets(request) {
  const overrideDir = request.args?.skillDir ? String(request.args.skillDir) : "";
  const provided = getProvidedSkill(request);
  const bundledSkill = await readFile(path.join(bundledSkillDir, "SKILL.md"), "utf8");
  const overrideSkill = overrideDir ? await readIfExists(path.join(overrideDir, "SKILL.md")) : "";
  const skill = overrideSkill || provided?.content || bundledSkill;
  const source = overrideSkill ? overrideDir : provided?.content ? "request.skills.stop-slop" : bundledSkillDir;

  const bundledReferences = await readReferences(bundledSkillDir);
  const overrideReferences = overrideDir ? {
    phrases: await readIfExists(path.join(overrideDir, "references", "phrases.md")),
    structures: await readIfExists(path.join(overrideDir, "references", "structures.md")),
    examples: await readIfExists(path.join(overrideDir, "references", "examples.md"))
  } : {};
  const references = {
    phrases: overrideReferences.phrases || bundledReferences.phrases,
    structures: overrideReferences.structures || bundledReferences.structures,
    examples: overrideReferences.examples || bundledReferences.examples
  };
  const referencesSource = overrideReferences.phrases || overrideReferences.structures || overrideReferences.examples
    ? overrideDir
    : bundledSkillDir;

  return {
    source,
    referencesSource,
    skill,
    references,
    phraseList: extractQuotedPhrases(references.phrases)
  };
}

const structurePatterns = [
  { name: "binary contrast", regex: /\b(not|isn't|wasn't|aren't|doesn't|don't)\b[^.?!]{0,100}\b(but|because|it's|actually)\b/i },
  { name: "negative listing", regex: /\bnot\s+(a|an|the)?\s*\w+[^.?!]*\.\s+not\s+(a|an|the)?\s*\w+/i },
  { name: "throat-clearing setup", regex: /\b(here's what|here's why|here's the|what if|think about it|this matters because|here's what i mean)\b/i },
  { name: "em dash", regex: /—/ },
  { name: "passive voice candidate", regex: /\b(was|were|is|are|be|been|being)\s+\w+ed\b/i },
  { name: "Wh-word sentence opener", regex: /(^|[.!?]\s+)(what|when|where|which|who|why|how)\b/i },
  { name: "vague importance", regex: /\b(significant|important|crucial|critical|fundamental|inherent|inevitable|structural)\b/i },
  { name: "lazy extreme", regex: /\b(every|always|never|everyone|everybody|nobody)\b/i },
  { name: "false agency candidate", regex: /\b(complaint|bet|decision|culture|conversation|data|market)\s+(becomes|emerges|shifts|moves|tells|rewards|lives|dies)\b/i }
];

function audit(text, phraseList) {
  const findings = [];
  for (const phrase of phraseList) {
    const regex = new RegExp(escapeRegex(phrase), "i");
    if (regex.test(text)) findings.push({ type: "phrase", item: phrase });
  }
  for (const pattern of structurePatterns) {
    if (pattern.regex.test(text)) findings.push({ type: "structure", item: pattern.name });
  }
  const adverbs = [...text.matchAll(/\b\w+ly\b/gi)].map((match) => match[0]).slice(0, 30);
  for (const word of [...new Set(adverbs)]) findings.push({ type: "adverb", item: word });
  return findings;
}

function brief(text, loadedSkill) {
  const parts = [
    "# Stop-slop writing brief",
    "",
    `Source: ${loadedSkill.source}`,
    `References: ${loadedSkill.referencesSource}`,
    "",
    "The tool loaded self-contained stop-slop skill assets. Apply these instructions to the next draft/revision.",
    "",
    "## SKILL.md",
    "",
    stripFrontmatter(loadedSkill.skill)
  ];

  if (loadedSkill.references.phrases) parts.push("", "## references/phrases.md", "", loadedSkill.references.phrases.trim());
  if (loadedSkill.references.structures) parts.push("", "## references/structures.md", "", loadedSkill.references.structures.trim());
  if (loadedSkill.references.examples) parts.push("", "## references/examples.md", "", loadedSkill.references.examples.trim());
  if (text) parts.push("", "## User brief / draft", "", text);

  return parts.join("\n").trim();
}

async function run(requestFile) {
  let toolError;
  try {
    const helpers = await importCore("core/tools/tool-result.js");
    const { toolOk } = helpers;
    toolError = helpers.toolError;
    if (!requestFile) throw new Error("Missing --request-file value");
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const text = String(request.text || request.artifact?.text || "").trim();
    const mode = String(request.args?.mode || "both");
    const loadedSkill = await resolveSkillAssets(request);
    const findings = mode !== "brief" ? audit(text, loadedSkill.phraseList) : [];
    const output = mode !== "audit" ? [brief(text, loadedSkill)] : [];

    if (mode !== "brief") {
      output.push(
        "",
        "## Deterministic flags",
        "",
        findings.length ? findings.map((f) => `- ${f.type}: ${f.item}`).join("\n") : "No obvious stop-slop flags found by deterministic scan."
      );
    }

    console.log(JSON.stringify(toolOk({
      text: output.join("\n").trim(),
      kind: "document",
      mimeType: "text/markdown",
      metadata: {
        skillSource: loadedSkill.source,
        referencesSource: loadedSkill.referencesSource
      }
    })));
  } catch (error) {
    const toErrorResult = toolError || ((message) => ({ ok: false, status: "failed", error: message }));
    console.log(JSON.stringify(toErrorResult(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
