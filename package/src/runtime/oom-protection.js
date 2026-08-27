import { writeFile } from "node:fs/promises";

const defaultCoreOomScoreAdjust = -900;

export async function protectCoreFromOom({
  platform = process.platform,
  score = defaultCoreOomScoreAdjust,
  writeScore = (value) => writeFile("/proc/self/oom_score_adj", `${value}\n`, "utf8"),
  logger
} = {}) {
  if (platform !== "linux") return false;
  try {
    await writeScore(score);
    logger?.log("service", `core OOM priority protected at ${score}`);
    return true;
  } catch (error) {
    logger?.log("service", `core OOM priority could not be lowered: ${error?.code || error?.message || error}`);
    return false;
  }
}
