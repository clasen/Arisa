import crypto from "node:crypto";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

export async function withSecureRequestFile({ directory, value, prefix = "request" }, useFile) {
  if (typeof useFile !== "function") throw new Error("Secure request handoff requires a consumer");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, `.${prefix}-${process.pid}-${crypto.randomUUID()}.json`);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    return await useFile(file);
  } finally {
    await rm(file, { force: true });
  }
}
