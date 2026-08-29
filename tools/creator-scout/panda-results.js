function decodeText(value) {
  return String(value || "")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function emailFrom(value) {
  return String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || null;
}

function activityFrom(value) {
  const matches = [...String(value || "").matchAll(/\b(today|yesterday|\d+\s+(?:days?|weeks?|months?|years?)\s+ago)\b/gi)];
  return matches.at(-1)?.[0] || null;
}

function elementGroups(elements) {
  const groups = [];
  let group = { references: [], email: null, findEmailNodeId: null };
  for (const element of elements) {
    const href = String(element?.href || "");
    const name = decodeText(element?.name);
    if (/youtube\.com\/watch|twitch\.tv\/videos/i.test(href)) group.references.push({ href, name });
    if (emailFrom(name)) group.email = emailFrom(name);
    if (name === "Find Email" && element.backendNodeId) group.findEmailNodeId = element.backendNodeId;
    if (name === "Open channel") {
      groups.push({ ...group, channelUrl: href || null });
      group = { references: [], email: null, findEmailNodeId: null };
    }
  }
  return groups;
}

function rowChunks(tree) {
  const lines = String(tree || "").split("\n");
  const headingIndex = lines.findIndex((line) => /heading '\d+ creators who cover games like/i.test(line));
  if (headingIndex < 0) return [];
  const chunks = [];
  let current = [];
  for (const line of lines.slice(headingIndex + 1)) {
    current.push(line);
    if (/link 'Open channel'\s*$/.test(line)) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }
  return chunks;
}

function parseReferenceName(value) {
  const match = decodeText(value).match(/^(.+?)\s+“\s+(.+?)\s+”$/);
  return match ? { benchmark: match[1], title: match[2] } : { benchmark: null, title: decodeText(value) || null };
}

function parseChunk(chunk, group) {
  const reference = parseReferenceName(group.references[0]?.name);
  return {
    name: decodeText(chunk.match(/image '(.+?) avatar'/)?.[1]) || null,
    handle: chunk.match(/\n\s*\d+ '@'\n\s*\d+ '([^']+)'/)?.[1] ? `@${chunk.match(/\n\s*\d+ '@'\n\s*\d+ '([^']+)'/)[1]}` : null,
    platform: chunk.match(/\n\s*\d+ '(YouTube|Twitch)'/i)?.[1]?.toLowerCase() || null,
    channelUrl: group.channelUrl,
    referenceTitle: reference.title,
    referenceUrl: group.references[0]?.href || null,
    subscribers: chunk.match(/\n\s*\d+ '([^']+)'\n\s*\d+ 'subs'/i)?.[1] || null,
    averageViews: chunk.match(/\n\s*\d+ '([^']+)'\n\s*\d+ 'avg views'/i)?.[1] || null,
    match: null,
    lastActive: activityFrom(chunk),
    email: group.email || emailFrom(chunk),
    findEmailNodeId: group.findEmailNodeId
  };
}

export function parsePandaResults(tree, elements) {
  const groups = elementGroups(elements);
  const chunks = rowChunks(tree);
  const total = Number(String(tree || "").match(/heading '(\d+) creators who cover games like/i)?.[1] || chunks.length);
  return {
    total,
    rows: chunks.slice(0, groups.length).map((chunk, index) => parseChunk(chunk, groups[index]))
  };
}
