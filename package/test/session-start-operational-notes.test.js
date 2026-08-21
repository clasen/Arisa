import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function loadNotesWithHome(homeDir, notesPayload) {
  await writeFile(
    path.join(homeDir, "state", "session-start-operational-notes.json"),
    JSON.stringify(notesPayload),
    "utf8"
  );

  const script = `
const mod = await import(${JSON.stringify(new URL("../src/core/agent/agent-session-lifecycle.js", import.meta.url).href)});
process.stdout.write(JSON.stringify(mod.loadSessionStartOperationalNotes()));
`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, ARISA_HOME: homeDir }
  });
  return JSON.parse(stdout);
}

test("loads bounded durable operational notes at session start", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-operational-notes-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await rm(path.join(homeDir, "state"), { recursive: true, force: true }).catch(() => {});
  await mkdir(path.join(homeDir, "state"), { recursive: true });

  const notes = await loadNotesWithHome(homeDir, {
    notes: [
      "  Responde   al owner en español por defecto.  ",
      { text: "Incluye reportes CBPR y tareas programadas." },
      "",
      null
    ]
  });

  assert.deepEqual(notes, [
    "Responde al owner en español por defecto.",
    "Incluye reportes CBPR y tareas programadas."
  ]);
});
