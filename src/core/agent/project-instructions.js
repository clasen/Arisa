import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const instructionsPath = fileURLToPath(new URL("../../../AGENTS.md", import.meta.url));
let cachedInstructions = null;

export async function loadProjectInstructions() {
  if (cachedInstructions !== null) return cachedInstructions;
  cachedInstructions = await readFile(instructionsPath, "utf8");
  return cachedInstructions;
}
