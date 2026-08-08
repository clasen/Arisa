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
  Load the complete stop-slop skill as writing context. The calling agent uses
  the skill to draft or review prose; this tool does not substitute regexes for
  editorial judgment.

Input:
  request.text or artifact.text: brief or draft text
  args.skillDir: optional local stop-slop skill directory containing SKILL.md
`);
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
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
    references
  };
}

function brief(text, loadedSkill) {
  const parts = [
    "# Stop-slop writing brief",
    "",
    `Source: ${loadedSkill.source}`,
    `References: ${loadedSkill.referencesSource}`,
    "",
    "Use the complete skill below for editorial judgment. Do not reduce its rules to keyword or regex checks.",
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
    const loadedSkill = await resolveSkillAssets(request);

    console.log(JSON.stringify(toolOk({
      text: brief(text, loadedSkill),
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
