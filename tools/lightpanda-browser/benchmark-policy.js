export const benchmarkFixtures = Object.freeze([
  Object.freeze({ id: "static", url: "https://example.com/", requiredText: Object.freeze(["Example Domain"]) }),
  Object.freeze({ id: "javascript", url: "https://demo-browser.lightpanda.io/amiibo/", requiredText: Object.freeze(["Sandy", "Animal Crossing", "Isabelle"]) }),
  Object.freeze({ id: "news", url: "https://news.ycombinator.com/", requiredText: Object.freeze(["Hacker News"]) })
]);

export const benchmarkEngines = Object.freeze(["web-browser", "lightpanda", "chromium"]);
export const benchmarkLimits = Object.freeze({ pages: 3, runsPerPage: 1, timeoutMs: 30_000, captureBytes: 1024 * 1024 });

export function contentMatchesFixture(fixture, content) {
  const text = String(content || "");
  return fixture.requiredText.every((expected) => text.includes(expected));
}

export function validateBenchmarkPolicy() {
  if (benchmarkFixtures.length > benchmarkLimits.pages || benchmarkLimits.runsPerPage !== 1) {
    throw new Error("Benchmark exceeds its fixed page or repetition budget.");
  }
  for (const fixture of benchmarkFixtures) {
    const url = new URL(fixture.url);
    if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error(`Benchmark fixture is not an anonymous public HTTPS URL: ${fixture.id}`);
    }
    if (!Array.isArray(fixture.requiredText) || fixture.requiredText.length === 0) {
      throw new Error(`Benchmark fixture has no semantic assertions: ${fixture.id}`);
    }
  }
  return true;
}
