import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getChatArtifactsDir, getChatArtifactsIndexFile, getChatArtifactsDatabaseFile } from "../../platform/paths.js";
import { withArtifactIndex, appendArtifact, getArtifact, listRecentArtifacts } from "./artifact-index.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function id() {
  return crypto.randomUUID();
}

function withUtf8Bom(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const body = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? bytes.subarray(UTF8_BOM.length)
    : bytes;
  return Buffer.concat([UTF8_BOM, body]);
}

function isTextMimeType(mimeType = "") {
  const type = mimeType.split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/")
    || type === "application/json"
    || type.endsWith("+json")
    || type === "application/xml"
    || type.endsWith("+xml")
    || type === "application/javascript"
    || type === "application/ecmascript"
    || type === "image/svg+xml";
}

function writeArtifactFile(filePath, content) {
  if (typeof content === "string") return writeFile(filePath, withUtf8Bom(content));
  return writeFile(filePath, content);
}

async function copyArtifactFile(originalPath, destPath, mimeType) {
  if (!isTextMimeType(mimeType)) return copyFile(originalPath, destPath);

  const content = await readFile(originalPath);
  new TextDecoder("utf-8", { fatal: true }).decode(content);
  return writeFile(destPath, withUtf8Bom(content));
}

class ChatArtifactStore {
  constructor(chatId) {
    this.chatId = String(chatId);
    this.rootDir = getChatArtifactsDir(this.chatId);
    this.index = {
      chatId: this.chatId,
      legacyFile: getChatArtifactsIndexFile(this.chatId),
      databaseFile: getChatArtifactsDatabaseFile(this.chatId)
    };
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    await withArtifactIndex(this.index, () => {});
  }

  async appendToIndex(artifact) {
    return withArtifactIndex(this.index, (db) => appendArtifact(db, artifact));
  }

  async createText({ text, mimeType = "text/plain", source, metadata = {} }) {
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
    return this.appendToIndex(artifact);
  }

  async createFileArtifact({ fileName, kind, mimeType, source, metadata = {}, writeFileContent }) {
    await this.init();
    const artifactId = id();
    const dir = path.join(this.rootDir, artifactId);
    await mkdir(dir, { recursive: true });
    const destPath = path.join(dir, fileName);
    await writeFileContent(destPath);
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
    return this.appendToIndex(artifact);
  }

  async createFromFile({ originalPath, fileName, kind, mimeType, source, metadata = {} }) {
    return this.createFileArtifact({
      fileName,
      kind,
      mimeType,
      source,
      metadata,
      writeFileContent: (destPath) => copyArtifactFile(originalPath, destPath, mimeType)
    });
  }

  async createGeneratedFile({ fileName, content, kind, mimeType, source, metadata = {} }) {
    return this.createFileArtifact({
      fileName,
      kind,
      mimeType,
      source,
      metadata,
      writeFileContent: (destPath) => writeArtifactFile(destPath, content)
    });
  }

  async get(artifactId) {
    return withArtifactIndex(this.index, (db) => getArtifact(db, artifactId));
  }

  async listRecent(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) {
      throw new RangeError("Artifact list limit must be an integer between 0 and 1000");
    }
    return withArtifactIndex(this.index, (db) => listRecentArtifacts(db, limit));
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
