import { rankToolMatches } from "./tool-registry.js";

const catalogApi = "https://api.github.com/repos/clasen/Arisa/contents/tools";
const rawBase = "https://raw.githubusercontent.com/clasen/Arisa/main/tools";

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`Official catalog request failed (${response.status})`);
  return response.json();
}

export async function searchOfficialToolCatalog(query, { fetchImpl = fetch } = {}) {
  const entries = await fetchJson(fetchImpl, catalogApi);
  const directories = entries.filter((entry) => entry.type === "dir" && entry.name);
  const manifests = (await Promise.all(directories.map(async ({ name }) => {
    try {
      return await fetchJson(fetchImpl, `${rawBase}/${encodeURIComponent(name)}/tool.manifest.json`);
    } catch {
      return null;
    }
  }))).filter(Boolean);
  return rankToolMatches(manifests, query).map(({ tool, score }) => ({
    name: tool.name,
    description: tool.description,
    input: tool.input,
    output: tool.output,
    category: tool.category || null,
    keywords: tool.keywords || [],
    score,
    source: "official-catalog"
  }));
}
