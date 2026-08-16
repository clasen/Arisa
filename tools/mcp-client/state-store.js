import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = { profiles: {} };

export function normalizeProfileName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) throw new Error("Profile must contain only lowercase letters, digits, and hyphens");
  return name;
}

export async function readState(stateDir) {
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, "profiles.json"), "utf8"));
    return { ...EMPTY_STATE, ...value, profiles: value.profiles || {} };
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(EMPTY_STATE);
    throw error;
  }
}

export async function writeState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, "profiles.json");
  const temporary = path.join(stateDir, `.profiles-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return state;
}

async function encryptionKey(globalStateDir) {
  await mkdir(globalStateDir, { recursive: true });
  const keyFile = path.join(globalStateDir, "credential.key");
  try {
    return Buffer.from(await readFile(keyFile, "utf8"), "base64");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const generated = crypto.randomBytes(32);
  try {
    await writeFile(keyFile, generated.toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return Buffer.from(await readFile(keyFile, "utf8"), "base64");
  }
}

export async function sealCredentials(globalStateDir, value) {
  const key = await encryptionKey(globalStateDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export async function openCredentials(globalStateDir, sealed) {
  if (!sealed) return {};
  const key = await encryptionKey(globalStateDir);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
