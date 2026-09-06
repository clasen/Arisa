import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLegacyArtifacts } from "../src/core/artifacts/legacy-artifact-reader.js";
import { withArtifactIndex, getArtifact, appendArtifact, listRecentArtifacts } from "../src/core/artifacts/artifact-index.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { chatId: "test", legacyFile: path.join(root, "artifacts.json"), databaseFile: path.join(root, "artifacts.sqlite") };
}

const artifacts = [
  { id: "a", chatId: "test", kind: "text", text: 'ñ🙂[\\\"}]\n', metadata: { nested: [{ x: true }] } },
  { id: "b", chatId: "test", kind: "document", path: "/unchanged/report.pdf", source: { type: "test" } }
];

test("legacy parser handles UTF-8, escaping and every token crossing chunk boundaries", async (t) => {
  const f = await fixture(t);
  await writeFile(f.legacyFile, JSON.stringify(artifacts, null, 2));
  for (const highWaterMark of [1, 2, 7, 64]) {
    const result = [];
    for await (const item of readLegacyArtifacts(f.legacyFile, { highWaterMark })) result.push(item);
    assert.deepEqual(result, artifacts);
  }
});

test("migration preserves all fields, order and original bytes; runs only once", async (t) => {
  const f = await fixture(t);
  const original = JSON.stringify(artifacts, null, 2);
  await writeFile(f.legacyFile, original);
  assert.deepEqual(await withArtifactIndex(f, db => listRecentArtifacts(db, 20)), artifacts.toReversed());
  assert.equal(await readFile(f.legacyFile, "utf8"), original);
  const next = { id: "c", chatId: "test", text: "new" };
  await withArtifactIndex(f, db => appendArtifact(db, next));
  assert.deepEqual(await withArtifactIndex(f, db => getArtifact(db, "a")), artifacts[0]);
  assert.deepEqual(await withArtifactIndex(f, db => listRecentArtifacts(db, 20)), [next, ...artifacts.toReversed()]);
  assert.equal((await stat(f.databaseFile)).mode & 0o777, 0o600);
  const db = new DatabaseSync(f.databaseFile);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
});

test("invalid migrations roll back completely and can be retried after repair", async (t) => {
  const f = await fixture(t);
  for (const broken of ['{}', '[', '[{}]', '[null]', '[1]', '[{"id":"a","chatId":"test"},]', JSON.stringify(artifacts).slice(0, -1), JSON.stringify(artifacts) + 'x', JSON.stringify([artifacts[0], artifacts[0]]), JSON.stringify([{...artifacts[0],chatId:"other"}])]) {
    await writeFile(f.legacyFile, broken);
    await assert.rejects(withArtifactIndex(f, () => {}), /Artifact index is unreadable/);
    assert.equal(await readFile(f.legacyFile, "utf8"), broken);
    const db = new DatabaseSync(f.databaseFile);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='artifacts'").get().n, 0);
    db.close();
  }
  await writeFile(f.legacyFile, JSON.stringify(artifacts));
  assert.deepEqual(await withArtifactIndex(f, db => getArtifact(db, "a")), artifacts[0]);
});

test("separate processes migrate and append without lost writes", async (t) => {
  const f = await fixture(t);
  await writeFile(f.legacyFile, JSON.stringify(artifacts));
  const moduleUrl = new URL("../src/core/artifacts/artifact-index.js", import.meta.url).href;
  await Promise.all(Array.from({length: 3}, (_, n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {withArtifactIndex,appendArtifact} from ${JSON.stringify(moduleUrl)};
      for(let i=0;i<20;i++) await withArtifactIndex(${JSON.stringify(f)}, db => appendArtifact(db, {id:'${n}-'+i,chatId:'test',text:'ok'}));
    `], {stdio:["ignore","ignore","pipe"]});
    let stderr = "";
    child.stderr.on("data", data => {stderr += data;});
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal((await withArtifactIndex(f, db => listRecentArtifacts(db, 100))).length, 62);
});

test("recent queries reject oversized results instead of materializing the whole selection", async (t) => {
  const f = await fixture(t);
  await withArtifactIndex(f, db => {
    for (let i = 0; i < 20; i++) appendArtifact(db, {id: String(i), chatId: 'test', text: 'x'.repeat(1024 * 1024)});
  });
  await assert.rejects(withArtifactIndex(f, db => listRecentArtifacts(db, 20)), /exceed 16 MiB/);
  assert.equal((await withArtifactIndex(f, db => listRecentArtifacts(db, 2))).length, 2);
  assert.deepEqual(await withArtifactIndex(f, db => listRecentArtifacts(db, 0)), []);
});
