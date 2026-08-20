const MAX_OPERATIONS = 32;
const MAX_DIMENSION = 16384;

const chainMethods = new Set([
  "affine", "autoOrient", "blur", "clahe", "convolve", "ensureAlpha", "extend", "extract",
  "flatten", "flip", "flop", "gamma", "grayscale", "greyscale", "linear", "median", "modulate",
  "negate", "normalise", "normalize", "pipelineColourspace", "pipelineColorspace", "recomb",
  "removeAlpha", "resize", "rotate", "sharpen", "threshold", "tint", "toColourspace",
  "toColorspace", "trim", "unflatten", "withExif", "withExifMerge", "withMetadata"
]);

const outputMethods = new Set(["avif", "gif", "heif", "jpeg", "png", "tiff", "webp"]);
const aliases = new Map([["jpg", "jpeg"], ["toFormat", "format"]]);

function number(value, fallback, min, max, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

function integer(value, fallback, min, max, name) {
  return Math.round(number(value, fallback, min, max, name));
}

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
}

function assertSafeValue(value, path = "args") {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 65536) throw new Error(`${path} is too large`);
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains an unsupported value`);
  for (const [key, item] of Object.entries(value)) {
    if (["input", "file", "path"].includes(key)) throw new Error(`${path}.${key} cannot reference local files`);
    if (["width", "height"].includes(key) && Number(item) > MAX_DIMENSION) throw new Error(`${path}.${key} cannot exceed ${MAX_DIMENSION}`);
    assertSafeValue(item, `${path}.${key}`);
  }
}

function methodOperation(operation) {
  const requested = String(operation.method || "");
  const method = aliases.get(requested) || requested;
  if (method === "format") {
    const format = String(operation.format || operation.args?.[0] || "jpeg").toLowerCase().replace("jpg", "jpeg");
    if (!outputMethods.has(format)) throw new Error(`Unsupported Sharp output format: ${format}`);
    const options = operation.options || operation.args?.[1];
    return { method: format, args: options === undefined ? [] : [options] };
  }
  if (!chainMethods.has(method) && !outputMethods.has(method)) throw new Error(`Unsupported Sharp method: ${method || "missing method"}`);
  let args = operation.args ?? (operation.options === undefined ? [] : [operation.options]);
  if (typeof args === "string") args = parseJson(args, `${method} args`);
  if (!Array.isArray(args)) throw new Error(`${method} args must be a JSON array`);
  assertSafeValue(args, `${method} args`);
  return { method, args };
}

function legacyCrop(operation) {
  if (operation.width || operation.height) {
    return {
      method: "extract",
      args: [{
        width: integer(operation.width, 1, 1, MAX_DIMENSION, "crop width"),
        height: integer(operation.height, 1, 1, MAX_DIMENSION, "crop height"),
        left: integer(operation.x, 0, 0, MAX_DIMENSION, "crop x"),
        top: integer(operation.y, 0, 0, MAX_DIMENSION, "crop y")
      }]
    };
  }
  return {
    method: "$focalCrop",
    args: [{
      zoom: number(operation.zoom, 1, 1, 8, "crop zoom"),
      focusX: number(operation.focusX, 0.5, 0, 1, "crop focusX"),
      focusY: number(operation.focusY, 0.5, 0, 1, "crop focusY")
    }]
  };
}

function legacyOperation(operation) {
  const type = String(operation.type || "").toLowerCase();
  if (type === "crop") return legacyCrop(operation);
  if (type === "resize") {
    const width = integer(operation.width, 1024, 1, MAX_DIMENSION, "resize width");
    const height = integer(operation.height, width, 1, MAX_DIMENSION, "resize height");
    return { method: "resize", args: [{ width, height, fit: operation.fit || "contain", background: operation.background || "black" }] };
  }
  if (type === "rotate") return { method: "rotate", args: [number(operation.degrees, 0, -360, 360, "rotate degrees"), { background: operation.background || { r: 0, g: 0, b: 0, alpha: 0 } }] };
  if (type === "flip") {
    if (!["horizontal", "vertical"].includes(operation.axis)) throw new Error("flip axis must be horizontal or vertical");
    return { method: operation.axis === "horizontal" ? "flop" : "flip", args: [] };
  }
  if (type === "adjust") return {
    method: "$adjust",
    args: [{
      brightness: number(operation.brightness, 0, -1, 1, "brightness"),
      contrast: number(operation.contrast, 1, 0.1, 3, "contrast"),
      saturation: number(operation.saturation, 1, 0, 3, "saturation")
    }]
  };
  if (type === "grayscale") return { method: "grayscale", args: [] };
  if (type === "blur") return { method: "blur", args: [number(operation.sigma, 1, 0.3, 1000, "blur sigma")] };
  if (type === "sharpen") return { method: "sharpen", args: [] };
  if (type === "format") {
    const format = String(operation.format || "jpeg").toLowerCase().replace("jpg", "jpeg");
    if (!outputMethods.has(format)) throw new Error(`Unsupported Sharp output format: ${format}`);
    return { method: format, args: [{ quality: integer(operation.quality, 90, 1, 100, "format quality") }] };
  }
  throw new Error(`Unsupported image operation: ${type || "missing type"}`);
}

export function parseOperations(value) {
  let operations = value;
  if (typeof operations === "string") operations = parseJson(operations, "operations");
  if (!Array.isArray(operations) || !operations.length) throw new Error("operations must be a non-empty JSON array");
  if (operations.length > MAX_OPERATIONS) throw new Error(`A maximum of ${MAX_OPERATIONS} operations is allowed`);
  return operations;
}

export function compileOperations(operations) {
  const pipeline = operations.map((operation) => operation?.method ? methodOperation(operation) : legacyOperation(operation || {}));
  const formatOperation = [...pipeline].reverse().find(({ method }) => outputMethods.has(method));
  if (!formatOperation) pipeline.push({ method: "jpeg", args: [{ quality: 90 }] });
  return { pipeline, format: formatOperation?.method || "jpeg" };
}

export const supportedSharpMethods = [...chainMethods, ...outputMethods, "format"].sort();
