export function referenceTitles(args = {}) {
  const value = args.referenceTitles ?? args.referenceTitle ?? args.comparableTitles;
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/\n|\|\|/).map((item) => item.trim()).filter(Boolean);
}

export function normalizedTitle(value) {
  return String(value || "")
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&quot;/gi, '"')
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function exactReferenceMatch(title, expectedTitles) {
  const actual = normalizedTitle(title);
  const matchedTitle = expectedTitles.find((expected) => {
    const normalizedExpected = normalizedTitle(expected);
    return normalizedExpected.length >= 3 && actual.includes(normalizedExpected);
  }) || null;
  return { exact: Boolean(matchedTitle), matchedTitle };
}
