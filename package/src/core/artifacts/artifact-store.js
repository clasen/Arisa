import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getChatArtifactsDir, getChatArtifactsIndexFile } from "../../platform/paths.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const indexOperations = new Map();

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

async function serializeIndexOperation(indexFile, operation) {
  const previous = indexOperations.get(indexFile) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  indexOperations.set(indexFile, current);
  try {
    return await current;
  } finally {
    if (indexOperations.get(indexFile) === current) indexOperations.delete(indexFile);
  }
}

async function syncParentDirectory(file) {
  let handle;
  try {
    handle = await open(path.dirname(file), "r");
    await handle.sync();
  } catch {
    // Some platforms do not support fsync on directories; rename remains atomic there.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeJsonAtomically(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${id()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await syncParentDirectory(file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
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
      const parsed = JSON.parse(await readFile(this.indexFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Artifact index must contain a JSON array");
      this.items = parsed;
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.items = [];
        return;
      }
      throw new Error(`Artifact index is unreadable: ${this.indexFile}`, { cause: error });
    }
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    if (!this.items) await this.reload();
  }

  async appendToIndex(artifact) {
    return serializeIndexOperation(this.indexFile, async () => {
      await this.reload();
      this.items.push(artifact);
      await writeJsonAtomically(this.indexFile, this.items);
      return artifact;
    });
  }

  async readIndex() {
    return serializeIndexOperation(this.indexFile, async () => {
      await this.reload();
      return this.items;
    });
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
    return this.appendToIndex(artifact);
  }

  async createFileArtifact({ fileName, kind, mimeType, source, metadata = {}, writeFileContent }) {
    await this.init();
    await this.reload();
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
    await this.init();
    const items = await this.readIndex();
    return items.find((item) => item.id === artifactId) || null;
  }

  async listRecent(limit = 20) {
    await this.init();
    const items = await this.readIndex();
    return [...items].slice(-limit).reverse();
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
