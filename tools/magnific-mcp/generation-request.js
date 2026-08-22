function clean(value) {
  return String(value ?? "").trim();
}

function integer(value, min, max, name) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function generationArguments(args = {}) {
  const prompt = clean(args.prompt);
  if (!prompt || prompt.length > 10000) throw new Error("prompt is required and must be at most 10000 characters");
  const mode = clean(args.mode || "imagen-nano-banana-2-lite");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(mode)) throw new Error("Invalid image model slug");
  const aspectRatio = clean(args.aspectRatio || "1:1");
  const allowedRatios = new Set(["1:1", "2:3", "3:2", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"]);
  if (!allowedRatios.has(aspectRatio)) throw new Error("Unsupported aspectRatio");
  const count = integer(args.count || 1, 1, 8, "count");
  const value = { prompt, mode, aspectRatio, count };
  if (clean(args.resolution)) value.resolution = clean(args.resolution);
  if (clean(args.quality)) value.quality = clean(args.quality);
  return value;
}

export async function startGeneration({ args, artifact, uploadReference, generate }) {
  const generationArgs = generationArguments(args);
  let reference = null;
  if (artifact) {
    const creationIdentifier = clean(await uploadReference(artifact));
    if (!creationIdentifier) throw new Error("Magnific reference upload returned no creation identifier");
    generationArgs.references = [{ type: "image", identifier: creationIdentifier }];
    reference = {
      type: "image",
      artifactId: clean(artifact.id) || null,
      creationIdentifier
    };
  }
  const started = await generate(generationArgs);
  return { generationArgs, reference, started };
}
