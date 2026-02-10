/**
 * @module core/file-detector
 * @role Detect file paths mentioned in Claude responses that exist on disk.
 * @responsibilities
 *   - Scan response text for absolute file paths
 *   - Verify they exist and are sendable (< 50MB, not directories)
 *   - Return list of unique valid file paths
 * @dependencies None
 * @effects Reads file system to check existence/size
 * @contract detectFiles(text) => string[]
 */

import { statSync } from "fs";

const FILE_PATH_REGEX = /(\/[\w./-]+\.\w{1,10})/gm;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export function detectFiles(text: string): string[] {
  const matches = [...text.matchAll(FILE_PATH_REGEX)];
  const seen = new Set<string>();
  const files: string[] = [];

  for (const match of matches) {
    const filePath = match[1];
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    try {
      const stat = statSync(filePath);
      if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
        files.push(filePath);
      }
    } catch {
      // File doesn't exist or can't be read
    }
  }

  return files;
}
