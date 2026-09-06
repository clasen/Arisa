import { createReadStream } from "node:fs";

// The legacy format is a JSON array of objects. Retain only one object's bytes,
// not the complete index. JSON.parse validates each object's JSON grammar.
export async function* readLegacyArtifacts(file, { highWaterMark = 64 * 1024 } = {}) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark });
  let state = "array";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let parts = [];
  for await (const chunk of stream) {
    let start = depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];
      if (depth) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
        if (!depth) {
          parts.push(chunk.slice(start, i + 1));
          const value = JSON.parse(parts.join(""));
          parts = [];
          start = -1;
          state = "separator";
          yield value;
        }
        continue;
      }
      if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
      if (state === "array" && char === "[") state = "first";
      else if ((state === "first" || state === "separator") && char === "]") state = "done";
      else if (state === "separator" && char === ",") state = "value";
      else if ((state === "first" || state === "value") && char === "{") {
        depth = 1;
        start = i;
      } else throw new Error("Invalid legacy artifact array");
    }
    if (start >= 0) parts.push(chunk.slice(start));
  }
  if (state !== "done" || depth) throw new Error("Truncated legacy artifact array");
}
