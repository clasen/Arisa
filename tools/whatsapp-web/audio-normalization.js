// Download retries belong to the media adapter, not this orchestration layer.
export async function normalizeAudio({ download, transcribe, sleep, attempts = 3 }) {
  let artifact = null;
  try {
    artifact = await download();
  } catch {
    // The adapter logs the download failure.
  }
  if (!artifact?.id) {
    return { artifact: null, transcript: "", status: "failed", error: "download_failed" };
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const transcript = String(await transcribe(artifact) || "").trim();
      if (transcript) return { artifact, transcript, status: "completed" };
    } catch {
      // Retry transcription only; reuse the existing artifact.
    }
    if (attempt + 1 < attempts) await sleep(2000 * (attempt + 1));
  }
  return { artifact, transcript: "", status: "failed", error: "transcription_failed" };
}
