/**
 * @module core/context
 * @role Manage Claude conversation continuity via the -c flag and reset_flag.
 * @responsibilities
 *   - Check if reset_flag exists (user sent /reset)
 *   - Return whether to use -c (continue) flag
 *   - Clear reset_flag after consuming it
 * @dependencies shared/config
 * @effects Reads/deletes .tinyclaw/reset_flag from disk
 * @contract shouldContinue() => boolean
 */

import { existsSync, unlinkSync } from "fs";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

export function shouldContinue(): boolean {
  if (existsSync(config.resetFlagPath)) {
    log.info("Reset flag found — starting fresh conversation");
    try {
      unlinkSync(config.resetFlagPath);
    } catch {
      // Already deleted, race condition
    }
    return false;
  }
  return true;
}
