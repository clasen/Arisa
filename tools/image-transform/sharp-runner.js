import sharp from "sharp";

const outputTypes = {
  avif: { extension: "avif", mimeType: "image/avif" },
  gif: { extension: "gif", mimeType: "image/gif" },
  heif: { extension: "heif", mimeType: "image/heif" },
  jpeg: { extension: "jpg", mimeType: "image/jpeg" },
  png: { extension: "png", mimeType: "image/png" },
  tiff: { extension: "tiff", mimeType: "image/tiff" },
  webp: { extension: "webp", mimeType: "image/webp" }
};

export function outputMetadata(format) {
  const metadata = outputTypes[format];
  if (!metadata) throw new Error(`Unsupported output format: ${format}`);
  return metadata;
}

async function focalCrop(image, options) {
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  const side = Math.max(1, Math.floor(Math.min(info.width, info.height) / options.zoom));
  const left = Math.round((info.width - side) * options.focusX);
  const top = Math.round((info.height - side) * options.focusY);
  return sharp(data, { failOn: "error", limitInputPixels: 100_000_000 }).extract({ left, top, width: side, height: side });
}

function adjust(image, options) {
  const offset = Math.round(options.brightness * 255);
  return image.linear(options.contrast, offset).modulate({ saturation: options.saturation });
}

export async function runSharp({ sourcePath, outputPath, pipeline }) {
  let image = sharp(sourcePath, {
    animated: true,
    failOn: "error",
    limitInputPixels: 100_000_000,
    sequentialRead: true
  });
  for (const operation of pipeline) {
    if (operation.method === "$focalCrop") image = await focalCrop(image, operation.args[0]);
    else if (operation.method === "$adjust") image = adjust(image, operation.args[0]);
    else image = image[operation.method](...operation.args);
  }
  return image.toFile(outputPath);
}
