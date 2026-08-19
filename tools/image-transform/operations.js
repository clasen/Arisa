function number(value, fallback, min, max, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

function integer(value, fallback, min, max, name) {
  return Math.round(number(value, fallback, min, max, name));
}

function safeColor(value) {
  const color = String(value || "black");
  if (!/^(#[0-9a-f]{6,8}|[a-z]+)$/i.test(color)) throw new Error("background must be a named color or #RRGGBB[AA]");
  return color;
}

export function parseOperations(value) {
  let operations = value;
  if (typeof value === "string") {
    try { operations = JSON.parse(value); } catch { throw new Error("operations must be valid JSON"); }
  }
  if (!Array.isArray(operations) || !operations.length) throw new Error("operations must be a non-empty JSON array");
  if (operations.length > 12) throw new Error("A maximum of 12 operations is allowed");
  return operations;
}

function cropFilter(operation) {
  if (operation.width || operation.height) {
    const width = integer(operation.width, 1, 1, 16384, "crop width");
    const height = integer(operation.height, 1, 1, 16384, "crop height");
    const x = integer(operation.x, 0, 0, 16384, "crop x");
    const y = integer(operation.y, 0, 0, 16384, "crop y");
    return `crop=${width}:${height}:${x}:${y}`;
  }
  const zoom = number(operation.zoom, 1, 1, 8, "crop zoom");
  const focusX = number(operation.focusX, 0.5, 0, 1, "crop focusX");
  const focusY = number(operation.focusY, 0.5, 0, 1, "crop focusY");
  const side = `min(iw\\,ih)/${zoom}`;
  return `crop=${side}:${side}:(iw-${side})*${focusX}:(ih-${side})*${focusY}`;
}

function resizeFilters(operation) {
  const width = integer(operation.width, 1024, 1, 16384, "resize width");
  const height = integer(operation.height, width, 1, 16384, "resize height");
  const fit = String(operation.fit || "contain");
  if (fit === "fill") return [`scale=${width}:${height}`];
  if (fit === "cover") return [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`];
  if (fit !== "contain") throw new Error("resize fit must be contain, cover, or fill");
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${safeColor(operation.background)}`
  ];
}

function rotateFilter(operation) {
  const degrees = number(operation.degrees, 0, -360, 360, "rotate degrees");
  if (degrees === 90 || degrees === -270) return "transpose=1";
  if (degrees === -90 || degrees === 270) return "transpose=2";
  if (Math.abs(degrees) === 180) return "hflip,vflip";
  return `rotate=${degrees}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`;
}

export function compileOperations(operations) {
  const filters = [];
  let format = "jpeg";
  let quality = 90;
  for (const operation of operations) {
    const type = String(operation?.type || "").toLowerCase();
    if (type === "crop") filters.push(cropFilter(operation));
    else if (type === "resize") filters.push(...resizeFilters(operation));
    else if (type === "rotate") filters.push(rotateFilter(operation));
    else if (type === "flip") {
      if (!['horizontal', 'vertical'].includes(operation.axis)) throw new Error("flip axis must be horizontal or vertical");
      filters.push(operation.axis === "horizontal" ? "hflip" : "vflip");
    } else if (type === "adjust") {
      const brightness = number(operation.brightness, 0, -1, 1, "brightness");
      const contrast = number(operation.contrast, 1, 0.1, 3, "contrast");
      const saturation = number(operation.saturation, 1, 0, 3, "saturation");
      filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
    } else if (type === "grayscale") filters.push("format=gray");
    else if (type === "blur") filters.push(`gblur=sigma=${number(operation.sigma, 1, 0.1, 100, "blur sigma")}`);
    else if (type === "sharpen") filters.push("unsharp=5:5:1.0:5:5:0.0");
    else if (type === "format") {
      format = String(operation.format || "jpeg").toLowerCase().replace("jpg", "jpeg");
      if (!["jpeg", "png", "webp"].includes(format)) throw new Error("format must be jpeg, png, or webp");
      quality = integer(operation.quality, 90, 1, 100, "format quality");
    } else throw new Error(`Unsupported image operation: ${type || "missing type"}`);
  }
  return { filters, format, quality };
}
