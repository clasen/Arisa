/**
 * @module shared/logger
 * @role Structured logging to .tinyclaw/logs/ and stdout.
 * @responsibilities
 *   - Create named loggers per component (core, daemon, telegram, scheduler)
 *   - Write timestamped log lines to file + console
 *   - Ensure log directory exists
 * @dependencies shared/config
 * @effects Writes to disk (.tinyclaw/logs/), writes to stdout
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config";

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export function createLogger(component: string) {
  const logFile = join(config.logsDir, `${component}.log`);

  if (!existsSync(config.logsDir)) {
    mkdirSync(config.logsDir, { recursive: true });
  }

  function write(level: Level, message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    console.log(line.trim());
    try {
      appendFileSync(logFile, line);
    } catch {
      // If we can't write to log file, at least console output happened
    }
  }

  return {
    debug: (msg: string) => write("DEBUG", msg),
    info: (msg: string) => write("INFO", msg),
    warn: (msg: string) => write("WARN", msg),
    error: (msg: string) => write("ERROR", msg),
  };
}
