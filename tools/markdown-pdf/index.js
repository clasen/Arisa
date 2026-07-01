import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import PdfPrinter from "pdfmake";
import defaults from "./config.js";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const toolName = "markdown-pdf";
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
function pickFont(candidates) {
  return candidates.find((fontPath) => existsSync(fontPath)) || candidates[0];
}

const fonts = {
  DejaVu: {
    normal: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "C:\\Windows\\Fonts\\arial.ttf"]),
    bold: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"]),
    italics: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/System/Library/Fonts/Supplemental/Arial Italic.ttf", "C:\\Windows\\Fonts\\ariali.ttf"]),
    bolditalics: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf", "C:\\Windows\\Fonts\\arialbi.ttf"])
  },
  DejaVuMono: {
    normal: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/System/Library/Fonts/Supplemental/Courier New.ttf", "C:\\Windows\\Fonts\\consola.ttf"]),
    bold: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "/System/Library/Fonts/Supplemental/Courier New Bold.ttf", "C:\\Windows\\Fonts\\consolab.ttf"]),
    italics: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Oblique.ttf", "/System/Library/Fonts/Supplemental/Courier New Italic.ttf", "C:\\Windows\\Fonts\\consolai.ttf"]),
    bolditalics: pickFont(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-BoldOblique.ttf", "/System/Library/Fonts/Supplemental/Courier New Bold Italic.ttf", "C:\\Windows\\Fonts\\consolaz.ttf"])
  }
};

function printHelp() {
  console.log(`markdown-pdf

Usage:
  node index.js run --request-file <json>

Converts Markdown text/artifacts to PDF using pdfmake.
`);
}

function parseMargin(value) {
  if (Array.isArray(value)) return value.map(Number);
  const parts = String(value || defaults.margin).split(/[, ]+/).filter(Boolean).map(Number);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[1], parts[0], parts[1], parts[0]];
  if (parts.length === 4) return parts;
  return [56, 56, 56, 56];
}

function slugFileName(value) {
  return String(value || "document").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

function textOf(tokens, start, end) {
  return tokens.slice(start, end).map((t) => t.content || "").join(" ").replace(/\s+/g, " ").trim();
}

function plainInline(children = []) {
  return children.map((child) => child.content || (child.children ? plainInline(child.children) : "")).join("");
}

function styleForHeading(level) {
  return `h${Math.min(Math.max(Number(level) || 1, 1), 6)}`;
}

function renderInline(children = [], inherited = {}) {
  const out = [];
  const marks = { ...inherited };
  for (let i = 0; i < children.length; i += 1) {
    const token = children[i];
    if (token.type === "text" || token.type === "code_inline") {
      out.push({ text: token.content || "", ...marks, ...(token.type === "code_inline" ? { style: "inlineCode" } : {}) });
    } else if (token.type === "softbreak") {
      out.push({ text: "\n", ...marks });
    } else if (token.type === "hardbreak") {
      out.push({ text: "\n", ...marks });
    } else if (token.type === "strong_open") {
      const close = findClose(children, i, "strong_close");
      out.push(...renderInline(children.slice(i + 1, close), { ...marks, bold: true }));
      i = close;
    } else if (token.type === "em_open") {
      const close = findClose(children, i, "em_close");
      out.push(...renderInline(children.slice(i + 1, close), { ...marks, italics: true }));
      i = close;
    } else if (token.type === "s_open") {
      const close = findClose(children, i, "s_close");
      out.push(...renderInline(children.slice(i + 1, close), { ...marks, decoration: "lineThrough" }));
      i = close;
    } else if (token.type === "link_open") {
      const close = findClose(children, i, "link_close");
      const href = token.attrGet?.("href") || "";
      out.push(...renderInline(children.slice(i + 1, close), { ...marks, color: "#2563eb", decoration: "underline", link: href }));
      i = close;
    } else if (token.type === "image") {
      const src = token.attrGet?.("src") || "";
      out.push({ text: token.content || token.attrGet?.("alt") || src, color: "#64748b", italics: true });
    } else if (token.children) {
      out.push(...renderInline(token.children, marks));
    } else if (token.content) {
      out.push({ text: token.content, ...marks });
    }
  }
  return out.length ? out : [{ text: "" }];
}

function findClose(tokens, from, type) {
  for (let i = from + 1; i < tokens.length; i += 1) if (tokens[i].type === type) return i;
  return from;
}

function paragraphFromInline(token, extra = {}) {
  return { text: renderInline(token.children || []), style: "paragraph", ...extra };
}

async function imageToDataUrl(src, baseDir) {
  try {
    let buffer;
    let mime = "image/png";
    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
      mime = res.headers.get("content-type")?.split(";")[0] || mime;
      buffer = Buffer.from(await res.arrayBuffer());
    } else if (/^data:image\//i.test(src)) {
      return src;
    } else {
      const filePath = path.resolve(baseDir || process.cwd(), src);
      const ext = path.extname(filePath).toLowerCase();
      mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      buffer = await readFile(filePath);
    }
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

async function convertTokens(tokens, { baseDir, maxImageWidth }) {
  const content = [];
  const stack = [{ type: "root", items: content }];

  function currentItems() { return stack[stack.length - 1].items; }
  function pushItem(item) { currentItems().push(item); }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      const inline = tokens[i + 1];
      const level = Number(token.tag?.slice(1) || 1);
      pushItem({ text: renderInline(inline?.children || []), style: styleForHeading(level) });
      i += 2;
    } else if (token.type === "paragraph_open") {
      const inline = tokens[i + 1];
      pushItem(paragraphFromInline(inline));
      i += 2;
    } else if (token.type === "fence" || token.type === "code_block") {
      pushItem({ text: token.content.replace(/\n$/, ""), style: "codeBlock" });
    } else if (token.type === "blockquote_open") {
      const quote = [];
      stack.push({ type: "blockquote", items: quote });
    } else if (token.type === "blockquote_close") {
      const quote = stack.pop().items;
      pushItem({ stack: quote, style: "blockquote" });
    } else if (token.type === "bullet_list_open") {
      const ul = [];
      stack.push({ type: "ul", items: ul });
    } else if (token.type === "ordered_list_open") {
      const ol = [];
      stack.push({ type: "ol", items: ol });
    } else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      const list = stack.pop();
      pushItem(list.type === "ol" ? { ol: list.items, style: "list" } : { ul: list.items, style: "list" });
    } else if (token.type === "list_item_open") {
      const item = [];
      stack.push({ type: "li", items: item });
    } else if (token.type === "list_item_close") {
      const item = stack.pop().items;
      const collapsed = item.length === 1 ? item[0] : { stack: item };
      currentItems().push(collapsed);
    } else if (token.type === "hr") {
      pushItem({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 480, y2: 0, lineWidth: 0.6, lineColor: "#cbd5e1" }], margin: [0, 10, 0, 10] });
    } else if (token.type === "table_open") {
      const { table, next } = parseTable(tokens, i);
      pushItem(table);
      i = next;
    } else if (token.type === "inline" && token.children?.some((child) => child.type === "image")) {
      for (const child of token.children) {
        if (child.type === "image") {
          const src = child.attrGet?.("src") || "";
          const img = await imageToDataUrl(src, baseDir);
          if (img) pushItem({ image: img, fit: [maxImageWidth, 420], margin: [0, 6, 0, 6] });
          else pushItem({ text: `[image: ${src}]`, italics: true, color: "#64748b" });
        }
      }
    }
  }
  return content;
}

function parseTable(tokens, start) {
  const body = [];
  let row = null;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "tr_open") row = [];
    else if (token.type === "tr_close") { body.push(row); row = null; }
    else if ((token.type === "th_open" || token.type === "td_open") && row) {
      const inline = tokens[i + 1];
      row.push({ text: renderInline(inline?.children || []), bold: token.type === "th_open", margin: [3, 3, 3, 3] });
      i += 2;
    } else if (token.type === "table_close") {
      return { table: { table: { headerRows: body.length ? 1 : 0, widths: body[0]?.map(() => "*") || ["*"], body: body.length ? body : [[""]] }, layout: "lightHorizontalLines", margin: [0, 6, 0, 10] }, next: i };
    }
  }
  return { table: { text: "" }, next: start };
}

function titleFromMarkdown(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[*_`#]/g, "").trim() : "document";
}

async function markdownToPdf(markdown, options = {}) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true }).enable("table").use(footnote).use(taskLists, { enabled: true });
  const tokens = md.parse(markdown, {});
  const content = await convertTokens(tokens, { baseDir: options.baseDir, maxImageWidth: Number(options.maxImageWidth || defaults.maxImageWidth) });
  const docDefinition = {
    pageSize: options.pageSize || defaults.pageSize,
    pageOrientation: options.pageOrientation || defaults.pageOrientation,
    pageMargins: parseMargin(options.margin || defaults.margin),
    info: { title: options.title || titleFromMarkdown(markdown) },
    content,
    defaultStyle: { font: "DejaVu", fontSize: Number(options.defaultFontSize || defaults.defaultFontSize), lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 24, bold: true, margin: [0, 0, 0, 12] },
      h2: { fontSize: 19, bold: true, margin: [0, 14, 0, 8] },
      h3: { fontSize: 16, bold: true, margin: [0, 12, 0, 6] },
      h4: { fontSize: 13.5, bold: true, margin: [0, 10, 0, 5] },
      h5: { fontSize: 12, bold: true, margin: [0, 8, 0, 4] },
      h6: { fontSize: 10.5, bold: true, color: "#475569", margin: [0, 8, 0, 4] },
      paragraph: { margin: [0, 0, 0, 7] },
      inlineCode: { font: "DejaVuMono", background: "#f1f5f9", color: "#0f172a" },
      codeBlock: { font: "DejaVuMono", fontSize: 9, background: "#f8fafc", color: "#0f172a", margin: [0, 4, 0, 8] },
      blockquote: { margin: [12, 4, 0, 8], color: "#475569", italics: true },
      list: { margin: [0, 0, 0, 7] }
    }
  };

  const printer = new PdfPrinter(fonts);
  return new Promise((resolve, reject) => {
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    pdfDoc.on("data", (chunk) => chunks.push(chunk));
    pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
    pdfDoc.on("error", reject);
    pdfDoc.end();
  });
}

async function readMarkdown(request) {
  if (request.artifact?.path) return readFile(request.artifact.path, "utf8");
  if (request.artifact?.text) return request.artifact.text;
  if (request.text) return request.text;
  if (request.args?.markdown) return String(request.args.markdown);
  return "";
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const markdown = await readMarkdown(request);
  if (!markdown.trim()) throw new Error("Markdown text or artifact is required");
  const args = request.args || {};
  const title = args.title || titleFromMarkdown(markdown);
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const pdf = await markdownToPdf(markdown, { ...config, ...args, baseDir: request.artifact?.path ? path.dirname(request.artifact.path) : process.cwd(), title });
  const outDir = path.join(process.cwd(), "tmp", "markdown-pdf");
  await mkdir(outDir, { recursive: true });
  const fileName = `${slugFileName(args.fileName || title)}.pdf`;
  const filePath = path.join(outDir, `${Date.now()}-${fileName}`);
  await writeFile(filePath, pdf);
  console.log(JSON.stringify({ ok: true, output: { filePath, fileName, mimeType: "application/pdf", kind: "document", delivery: { method: "document" } } }));
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") {
  const i = args.indexOf("--request-file");
  run(args[i + 1]).catch((error) => console.log(JSON.stringify({ ok: false, error: error.message || String(error) })));
} else printHelp();

export { markdownToPdf };
