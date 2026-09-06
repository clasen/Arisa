import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("migrates a 100 MiB history and repeatedly accesses it with a 48 MiB heap", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {chatId:"test",legacyFile:path.join(root,"artifacts.json"),databaseFile:path.join(root,"artifacts.sqlite")};
  const file = await open(options.legacyFile, "wx", 0o600);
  try {
    await file.write("[");
    for (let i = 0; i < 1024; i++) {
      await file.write((i ? "," : "") + JSON.stringify({id:String(i),chatId:"test",text:"x".repeat(100*1024)}));
    }
    await file.write("]");
  } finally { await file.close(); }
  const moduleUrl = new URL("../src/core/artifacts/artifact-index.js", import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import {withArtifactIndex,getArtifact,appendArtifact,listRecentArtifacts} from ${JSON.stringify(moduleUrl)};
    const f=${JSON.stringify(options)};
    const start=performance.now();
    await withArtifactIndex(f,db=>assert.equal(getArtifact(db,'0').text.length,102400));
    const migrated=performance.now();
    for(let i=0;i<100;i++) {
      await withArtifactIndex(f,db=>appendArtifact(db,{id:'new-'+i,chatId:'test',text:'small'}));
      await withArtifactIndex(f,db=>assert.equal(getArtifact(db,String(i)).text.length,102400));
      await withArtifactIndex(f,db=>assert.equal(listRecentArtifacts(db,20).length,20));
    }
    await withArtifactIndex(f,db=>assert.equal(db.prepare('SELECT count(*) AS n FROM artifacts').get().n,1124));
    console.log(JSON.stringify({migrationMs:Math.round(migrated-start),operationsMs:Math.round(performance.now()-migrated),maxRssKiB:process.resourceUsage().maxRSS,heapMiB:Math.round(process.memoryUsage().heapUsed/1048576)}));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=48", "--input-type=module", "-e", code], {stdio:["ignore","pipe","pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => {stdout += data;});
    child.stderr.on("data", data => {stderr += data;});
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.heapMiB < 48);
});
