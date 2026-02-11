/**
 * @module shared/paths
 * @role Resolve project and runtime data directories with migration-safe defaults.
 * @responsibilities
 *   - Resolve project directory (supports ARISA_PROJECT_DIR override)
 *   - Resolve runtime data directory (prefers .arisa, falls back to legacy .tinyclaw)
 *   - Support ARISA_DATA_DIR override for advanced deployments
 */

import { existsSync } from "fs";
import { isAbsolute, join, resolve } from "path";

const DEFAULT_PROJECT_DIR = join(import.meta.dir, "..", "..");
const PROJECT_DIR = process.env.ARISA_PROJECT_DIR
  ? resolve(process.env.ARISA_PROJECT_DIR)
  : DEFAULT_PROJECT_DIR;

const PREFERRED_DATA_DIR = join(PROJECT_DIR, ".arisa");
const LEGACY_DATA_DIR = join(PROJECT_DIR, ".tinyclaw");

function resolveDataDir(): string {
  const override = process.env.ARISA_DATA_DIR?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(PROJECT_DIR, override);
  }

  if (existsSync(PREFERRED_DATA_DIR)) return PREFERRED_DATA_DIR;
  if (existsSync(LEGACY_DATA_DIR)) return LEGACY_DATA_DIR;
  return PREFERRED_DATA_DIR;
}

export const projectDir = PROJECT_DIR;
export const preferredDataDir = PREFERRED_DATA_DIR;
export const legacyDataDir = LEGACY_DATA_DIR;
export const dataDir = resolveDataDir();

