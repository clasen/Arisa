import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const defaultSkillsDir = path.join(os.homedir(), ".agents", "skills");

function parseFrontmatter(source = "") {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = source.slice(3, end).trim();
  const data = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return data;
}

function normalizeSkillHint(value) {
  if (typeof value === "string") return { name: value, when: "" };
  if (value && typeof value === "object" && value.name) {
    return { name: String(value.name), when: String(value.when || "") };
  }
  return null;
}

export class SkillRegistry {
  constructor({ skillsDir = defaultSkillsDir } = {}) {
    this.skillsDir = skillsDir;
    this.cache = new Map();
  }

  async get(name) {
    const key = String(name || "").trim();
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key);

    const file = path.join(this.skillsDir, key, "SKILL.md");
    try {
      const content = await readFile(file, "utf8");
      const metadata = parseFrontmatter(content);
      const skill = {
        name: metadata.name || key,
        description: metadata.description || "",
        path: file,
        content
      };
      this.cache.set(key, skill);
      return skill;
    } catch {
      this.cache.set(key, null);
      return null;
    }
  }

  normalizeHints(manifest = {}) {
    const raw = manifest.skillHints || manifest.skills || [];
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeSkillHint).filter(Boolean);
  }

  async resolveHints(hints = []) {
    const resolved = [];
    for (const hint of hints) {
      const skill = await this.get(hint.name);
      resolved.push({ ...hint, found: Boolean(skill), skill });
    }
    return resolved;
  }
}
