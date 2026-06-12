import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getChatArtifactsDir, getChatArtifactsIndexFile } from "../../runtime/paths.js";

function id() {
  return crypto.randomUUID();
}

class ChatArtifactStore {
  constructor(chatId) {
    this.chatId = String(chatId);
    this.rootDir = getChatArtifactsDir(this.chatId);
    this.indexFile = getChatArtifactsIndexFile(this.chatId);
    this.items = null;
  }

  async reload() {
    try {
      this.items = JSON.parse(await readFile(this.indexFile, "utf8"));
    } catch {
      this.items = [];
    }
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    if (!this.items) await this.reload();
  }

  async saveIndex() {
    await mkdir(path.dirname(this.indexFile), { recursive: true });
    await writeFile(this.indexFile, `${JSON.stringify(this.items, null, 2)}\n`, "utf8");
  }

  async createText({ text, mimeType = "text/plain", source, metadata = {} }) {
    await this.init();
    await this.reload();
    const artifact = {
      id: id(),
      chatId: this.chatId,
      kind: "text",
      mimeType,
      text,
      source,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.items.push(artifact);
    await this.saveIndex();
    return artifact;
  }

  async createFromFile({ originalPath, fileName, kind, mimeType, source, metadata = {} }) {
    await this.init();
    await this.reload();
    const artifactId = id();
    const dir = path.join(this.rootDir, artifactId);
    await mkdir(dir, { recursive: true });
    const destPath = path.join(dir, fileName);
    await copyFile(originalPath, destPath);
    const artifact = {
      id: artifactId,
      chatId: this.chatId,
      kind,
      mimeType,
      path: destPath,
      source,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.items.push(artifact);
    await this.saveIndex();
    return artifact;
  }

  async createGeneratedFile({ fileName, content, kind, mimeType, source, metadata = {} }) {
    await this.init();
    await this.reload();
    const artifactId = id();
    const dir = path.join(this.rootDir, artifactId);
    await mkdir(dir, { recursive: true });
    const destPath = path.join(dir, fileName);
    await writeFile(destPath, content);
    const artifact = {
      id: artifactId,
      chatId: this.chatId,
      kind,
      mimeType,
      path: destPath,
      source,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.items.push(artifact);
    await this.saveIndex();
    return artifact;
  }

  async get(artifactId) {
    await this.init();
    await this.reload();
    return this.items.find((item) => item.id === artifactId) || null;
  }

  async listRecent(limit = 20) {
    await this.init();
    await this.reload();
    return [...this.items].slice(-limit).reverse();
  }
}

export class ArtifactStore {
  constructor() {
    this.chatStores = new Map();
  }

  forChat(chatId) {
    const key = String(chatId);
    if (!this.chatStores.has(key)) {
      this.chatStores.set(key, new ChatArtifactStore(key));
    }
    return this.chatStores.get(key);
  }
}
