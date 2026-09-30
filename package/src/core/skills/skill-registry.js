import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

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

    // Revalidate by file identity so skills installed or edited after startup are seen,
    // while unchanged skills are served without re-reading their content.
    const file = path.join(this.skillsDir, key, "SKILL.md");
    let fingerprint;
    try {
      const stats = await stat(file, { bigint: true });
      fingerprint = `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
    } catch {
      this.cache.delete(key);
      return null;
    }
    const cached = this.cache.get(key);
    if (cached?.fingerprint === fingerprint) return cached.skill;

    try {
      const content = await readFile(file, "utf8");
      const metadata = parseFrontmatter(content);
      const skill = {
        name: metadata.name || key,
        description: metadata.description || "",
        path: file,
        content
      };
      this.cache.set(key, { fingerprint, skill });
      return skill;
    } catch {
      this.cache.delete(key);
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
