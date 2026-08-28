import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { normalizeInteractionSteps } from "./mcp-session.js";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sensitivePattern = /(?:passw|passwd|secret|token|api[_-]?key|credit[_-]?card|card[_-]?number|cvv|cvc|bearer|\$LP_)/i;

function assertId(id) {
  const value = String(id || "").trim();
  if (!idPattern.test(value)) throw new Error("Invalid recipeId.");
  return value;
}

function assertNoSensitiveRecipeValues(step) {
  if (["fill", "press"].includes(step.tool)) {
    throw Object.assign(new Error("Recipes cannot persist text entry or key presses; use a live temporary session instead."), {
      code: "LIGHTPANDA_RECIPE_UNSAFE"
    });
  }
  const serialized = JSON.stringify(step.arguments || {});
  if (sensitivePattern.test(serialized)) {
    throw Object.assign(new Error("Recipes cannot persist credential, token, password, or payment-like selectors or values."), {
      code: "LIGHTPANDA_RECIPE_UNSAFE"
    });
  }
}

export async function validateRecipe({ name, steps, actionLevel = "read", lookup }) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName || normalizedName.length > 80) throw new Error("Recipe name must contain 1 to 80 characters.");
  const level = String(actionLevel || "read").trim().toLowerCase();
  if (!new Set(["read", "interact"]).has(level)) {
    throw Object.assign(new Error("Recipes support only read or interact action levels; commit actions cannot be replayed."), { code: "LIGHTPANDA_RECIPE_UNSAFE" });
  }
  const normalized = await normalizeInteractionSteps(steps, { actionLevel: level, lookup });
  const canonicalSteps = normalized.map((step) => ({ tool: step.tool, arguments: step.arguments }));
  canonicalSteps.forEach(assertNoSensitiveRecipeValues);
  return { name: normalizedName, actionLevel: level, steps: canonicalSteps };
}

export class RecipeStore {
  constructor(rootDir) {
    if (!path.isAbsolute(rootDir)) throw new Error("Recipe state directory must be absolute.");
    this.rootDir = path.join(rootDir, "recipes");
  }

  file(id) {
    return path.join(this.rootDir, `${assertId(id)}.json`);
  }

  async save(recipe) {
    await mkdir(this.rootDir, { recursive: true });
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), ...recipe, createdAt: now, updatedAt: now };
    const destination = this.file(record.id);
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return record;
  }

  async get(id) {
    const record = JSON.parse(await readFile(this.file(id), "utf8"));
    if (record.id !== String(id)) throw new Error("Recipe identity mismatch.");
    return record;
  }

  async list() {
    const names = await readdir(this.rootDir).catch(() => []);
    const records = [];
    for (const name of names.filter((item) => idPattern.test(item.replace(/\.json$/, "")) && item.endsWith(".json")).sort()) {
      try { records.push(JSON.parse(await readFile(path.join(this.rootDir, name), "utf8"))); }
      catch { /* Ignore malformed state records instead of executing them. */ }
    }
    return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async delete(id) {
    const recipeId = assertId(id);
    try {
      await unlink(this.file(recipeId));
      return { id: recipeId, deleted: true };
    } catch (error) {
      if (error?.code === "ENOENT") return { id: recipeId, deleted: false };
      throw error;
    }
  }
}
