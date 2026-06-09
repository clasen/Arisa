function mimeMatches(pattern, mimeType = "") {
  if (!pattern || !mimeType) return false;
  if (pattern === mimeType) return true;
  if (pattern.endsWith("/*")) return mimeType.startsWith(`${pattern.slice(0, -2)}/`);
  return false;
}

function toolSupportsArtifact(tool, artifact) {
  const inputs = Array.isArray(tool.input) ? tool.input : [];
  return inputs.some((input) => mimeMatches(input, artifact.mimeType));
}

function toolProduces(tool, mimeType) {
  const outputs = Array.isArray(tool.output) ? tool.output : [];
  return outputs.some((output) => mimeMatches(output, mimeType));
}

function looksLikeAudioTranscriptionTool(tool) {
  return /transcri|whisper|speech.?to.?text|audio.?to.?text/i.test(`${tool.name} ${tool.description || ""}`);
}

export function shouldNormalizeArtifactToText(artifact, desiredMimeType = "text/plain") {
  return desiredMimeType === "text/plain"
    && (artifact?.mimeType?.startsWith("audio/") || artifact?.mimeType?.startsWith("video/"));
}

export function selectPipeTool({ toolRegistry, artifact, desiredMimeType }) {
  const tools = toolRegistry.list()
    .filter((tool) => toolSupportsArtifact(tool, artifact))
    .filter((tool) => toolProduces(tool, desiredMimeType));

  if (shouldNormalizeArtifactToText(artifact, desiredMimeType)) {
    return tools.find(looksLikeAudioTranscriptionTool) || null;
  }

  return null;
}

export async function normalizeArtifactForReasoning({
  artifact,
  desiredMimeType = "text/plain",
  toolRegistry,
  chatArtifactStore,
  chatId
}) {
  if (!artifact) return { normalizedArtifact: null, toolResult: null, toolName: "" };

  if (!shouldNormalizeArtifactToText(artifact, desiredMimeType)) {
    return { normalizedArtifact: null, toolResult: null, toolName: "" };
  }

  const tool = selectPipeTool({ toolRegistry, artifact, desiredMimeType });
  if (!tool) {
    return {
      normalizedArtifact: null,
      toolResult: {
        ok: false,
        status: "failed",
        error: `No registered tool can normalize ${artifact.mimeType} to ${desiredMimeType}.`
      },
      toolName: ""
    };
  }

  const result = await toolRegistry.run({
    name: tool.name,
    request: { artifact, args: {} },
    chatId
  });

  if (!result.ok) {
    return { normalizedArtifact: null, toolResult: result, toolName: tool.name };
  }

  if (!result.output?.text) {
    return {
      normalizedArtifact: null,
      toolResult: { ok: false, status: "failed", error: "Normalization returned no text." },
      toolName: tool.name
    };
  }

  const normalizedArtifact = await chatArtifactStore.createText({
    text: result.output.text,
    mimeType: desiredMimeType,
    source: { type: "tool", toolName: tool.name },
    metadata: { fromArtifactId: artifact.id, tool: tool.name, normalization: true }
  });

  return { normalizedArtifact, toolResult: result, toolName: tool.name };
}
