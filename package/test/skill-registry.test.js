import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillRegistry } from "../src/core/skills/skill-registry.js";

test("sees skills installed or edited after a lookup", async () => {
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), "arisa-skills-"));
  try {
    const registry = new SkillRegistry({ skillsDir });
    assert.equal(await registry.get("late-skill"), null);

    const file = path.join(skillsDir, "late-skill", "SKILL.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "---\nname: late-skill\ndescription: First\n---\nBody\n", "utf8");
    const installed = await registry.get("late-skill");
    assert.equal(installed.description, "First");
    assert.equal(await registry.get("late-skill"), installed);

    await writeFile(file, "---\nname: late-skill\ndescription: Second version\n---\nBody\n", "utf8");
    assert.equal((await registry.get("late-skill")).description, "Second version");

    await rm(path.dirname(file), { recursive: true });
    assert.equal(await registry.get("late-skill"), null);
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});
