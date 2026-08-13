import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readSecureJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeSecureJson(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
