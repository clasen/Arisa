import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { RecipeStore, validateRecipe } from "../recipe-store.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];
const readSteps = [
  { tool: "goto", arguments: { url: "https://example.com" } },
  { tool: "extract", arguments: { schema: '{"title":"h1"}' } }
];

test("recipe save, list, get, and delete round trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lp-recipe-test-"));
  try {
    const store = new RecipeStore(root);
    const validated = await validateRecipe({ name: "Example title", steps: readSteps, actionLevel: "read", lookup: publicLookup });
    const saved = await store.save(validated);
    assert.match(saved.id, /^[0-9a-f-]{36}$/i);
    assert.equal(saved.steps[0].arguments.url, "https://example.com/");
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.get(saved.id)).name, "Example title");
    assert.deepEqual(await store.delete(saved.id), { id: saved.id, deleted: true });
    assert.equal((await store.list()).length, 0);
    assert.deepEqual(await store.delete(saved.id), { id: saved.id, deleted: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recipe state is isolated by chat root", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "lp-recipe-chat-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "lp-recipe-chat-b-"));
  try {
    const a = new RecipeStore(rootA);
    const b = new RecipeStore(rootB);
    const saved = await a.save(await validateRecipe({ name: "Only A", steps: readSteps, lookup: publicLookup }));
    assert.equal((await a.list()).length, 1);
    assert.equal((await b.list()).length, 0);
    await assert.rejects(b.get(saved.id), (error) => error.code === "ENOENT");
  } finally {
    await Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })]);
  }
});

test("recipes reject commit, credentials, private URLs, and arbitrary code", async () => {
  await assert.rejects(validateRecipe({ name: "Commit", steps: readSteps, actionLevel: "commit", lookup: publicLookup }), /only read or interact/);
  await assert.rejects(validateRecipe({
    name: "Credential",
    actionLevel: "interact",
    lookup: publicLookup,
    steps: [{ tool: "fill", arguments: { selector: "input.password", value: "secret-value" } }]
  }), (error) => error.code === "LIGHTPANDA_RECIPE_UNSAFE");
  await assert.rejects(validateRecipe({
    name: "Key entry",
    actionLevel: "interact",
    steps: [{ tool: "press", arguments: { selector: "input", key: "a" } }]
  }), (error) => error.code === "LIGHTPANDA_RECIPE_UNSAFE");
  await assert.rejects(validateRecipe({ name: "Private", steps: [{ tool: "goto", arguments: { url: "http://127.0.0.1" } }] }), /Private or non-public/);
  await assert.rejects(validateRecipe({ name: "Code", steps: [{ tool: "evaluate", arguments: { script: "fetch('/secret')" } }] }), /unsupported tool/);
  await assert.rejects(validateRecipe({
    name: "Submit",
    actionLevel: "interact",
    steps: [{ tool: "press", arguments: { selector: "input", key: "Enter" } }]
  }), /actionLevel=commit/);
});
