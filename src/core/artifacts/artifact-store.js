import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const rootDir = path.resolve("data/artifacts");
const indexFile = path.resolve("data/state/artifacts.json");

async function loadIndex() {
  try {
    return JSON.parse(await readFile(indexFile, "utf8"));
  } catch {
    return [];
  }
}

async function saveIndex(items) {
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function id() {
  return crypto.randomUUID();
}

export class ArtifactStore {
  constructor() {
    this.items = null;
  }

  async init() {
    if (!this.items) this.items = await loadIndex();
    await mkdir(rootDir, { recursive: true });
  }

  async createText({ text, mimeType = "text/plain", source, metadata = {} }) {
    await this.init();
    const artifact = {
      id: id(),
      kind: "text",
      mimeType,
      text,
      source,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.items.push(artifact);
    await saveIndex(this.items);
    return artifact;
  }

  async createFromFile({ originalPath, fileName, kind, mimeType, source, metadata = {} }) {
    await this.init();
    const artifactId = id();
    const dir = path.join(rootDir, artifactId);
    await mkdir(dir, { recursive: true });
    const destPath = path.join(dir, fileName);
    await copyFile(originalPath, destPath);
    const artifact = {
      id: artifactId,
      kind,
      mimeType,
      path: destPath,
      source,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.items.push(artifact);
    await saveIndex(this.items);
    return artifact;
  }

  async createGeneratedFile({ fileName, content, kind, mimeType, source, metadata = {} }) {
    await this.init();
    const artifactId = id();
    const dir = path.join(rootDir, artifactId);
    await mkdir(dir, { recursive: true });
    const destPath = path.join(dir, fileName);
    await writeFile(destPath, content);
    const artifact = {
      id: artifactId,
      kind,
      mimeType,
      path: destPath,
      source,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.items.push(artifact);
    await saveIndex(this.items);
    return artifact;
  }

  async get(id) {
    await this.init();
    return this.items.find((item) => item.id === id) || null;
  }

  async listRecent(limit = 20) {
    await this.init();
    return [...this.items].slice(-limit).reverse();
  }
}
