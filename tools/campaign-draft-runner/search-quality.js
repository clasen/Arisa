import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const COVERAGE_MARKERS = /\b(review|reviews|reviewed|test|tested|critique|analysis|article|feature|walkthrough|podcast|episode|recension(?:e|i)?|recenzja|rezension|reseña|an[aá]lisis|an[aá]lise|inceleme|ulasan|đánh giá|รีวิว)\b|評測|测评|レビュー|리뷰|مراجعة|समीक्षा/i;
const IRRELEVANT_MARKERS = /dictionary|wikipedia|wiktionary|merriam-webster|cambridge dictionary|google play|app store|apkpure|softonic|fandom|steam community|steam store|microsoft|careers?|jobs?|directory|aggregator/i;

function parseResults(text) {
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const title = lines[index].match(/^\s*\d+[.)]\s+(.+)$/)?.[1]?.trim();
    if (!title) continue;
    let url = "";
    let snippet = "";
    for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
      const line = lines[index + offset].trim();
      if (/^\d+[.)]\s+/.test(line)) break;
      const urlMatch = line.match(/^URL:\s*(https?:\/\/\S+)/i);
      const snippetMatch = line.match(/^Snippet:\s*(.*)$/i);
      if (urlMatch) url = urlMatch[1];
      if (snippetMatch) snippet = snippetMatch[1];
    }
    if (url) results.push({ title, url, snippet });
  }
  return results;
}

function classifyResult(result) {
  const text = `${result.title} ${result.snippet} ${result.url}`;
  const irrelevant = IRRELEVANT_MARKERS.test(text);
  return { ...result, relevantCoverage: !irrelevant && COVERAGE_MARKERS.test(text) };
}

export function assessSearchQuality(searches) {
  const normalized = Array.isArray(searches) ? searches.slice(0, 6) : [];
  const results = normalized.flatMap((search) => parseResults(search?.text).map(classifyResult));
  const relevantCoverageResults = results.filter((result) => result.relevantCoverage).length;
  const totalResults = results.length;
  const irrelevantResults = totalResults - relevantCoverageResults;
  const irrelevanceRate = totalResults ? irrelevantResults / totalResults : 1;
  const quality = totalResults > 0 && relevantCoverageResults > 0 && irrelevanceRate < 0.8 ? "healthy" : "poor";
  const strategy = quality === "poor" ? "source-directed" : "coverage-expansion";
  return {
    searches: normalized.length,
    totalResults,
    relevantCoverageResults,
    irrelevantResults,
    irrelevanceRate: Number(irrelevanceRate.toFixed(3)),
    quality,
    strategy,
    guidance: quality === "poor"
      ? [
          "Use a simple native-language competitor title plus one review term; omit contact and email terms.",
          "Open a credible coverage result before looking for the author or outlet contact.",
          "Use remaining searches for a promising source domain, exact localized alias, or identified reviewer."
        ]
      : [
          "Keep the remaining hypotheses distinct by changing competitor, language, or coverage format.",
          "Open the strongest coverage before searching its author or official contact source."
        ]
  };
}

async function readHistory(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, cycles: [] };
    throw error;
  }
}

export async function recordSearchQuality(stateDir, profile, assessment) {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, "search-quality.json");
  const state = await readHistory(file);
  const cycle = {
    recordedAt: new Date().toISOString(),
    profile,
    searches: assessment.searches,
    totalResults: assessment.totalResults,
    relevantCoverageResults: assessment.relevantCoverageResults,
    irrelevantResults: assessment.irrelevantResults,
    irrelevanceRate: assessment.irrelevanceRate,
    quality: assessment.quality,
    strategy: assessment.strategy
  };
  state.cycles = [...(state.cycles || []), cycle].slice(-5);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  return { ...assessment, measurementWindow: state.cycles };
}
