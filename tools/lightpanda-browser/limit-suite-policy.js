export const limitFixtures = Object.freeze([
  Object.freeze({ id: "react-todomvc", category: "react", url: "https://todomvc.com/examples/react/dist/", requiredText: Object.freeze(["todos", "TodoMVC"]) }),
  Object.freeze({ id: "vue-todomvc", category: "vue", url: "https://todomvc.com/examples/vue/dist/", requiredText: Object.freeze(["todos", "TodoMVC"]) }),
  Object.freeze({ id: "angular-todomvc", category: "angular", url: "https://todomvc.com/examples/angular/dist/browser/", requiredText: Object.freeze(["Angular", "Todos"]) }),
  Object.freeze({ id: "public-form", category: "forms", url: "https://httpbin.org/forms/post", requiredText: Object.freeze(["Customer name", "Telephone"]) }),
  Object.freeze({ id: "css-modal", category: "modals", url: "https://www.w3schools.com/howto/howto_css_modals.asp", requiredText: Object.freeze(["Open Modal"]) }),
  Object.freeze({ id: "html-table", category: "tables", url: "https://www.w3schools.com/html/html_tables.asp", requiredText: Object.freeze(["Company", "Alfreds Futterkiste"]) }),
  Object.freeze({ id: "long-news-page", category: "scrolling", url: "https://news.ycombinator.com/news?p=2", requiredText: Object.freeze(["Hacker News"]) }),
  Object.freeze({ id: "public-redirect", category: "redirects", url: "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F", finalUrl: "https://example.com/", requiredText: Object.freeze(["Example Domain"]) }),
  Object.freeze({ id: "html-iframe", category: "iframes", url: "https://www.w3schools.com/html/html_iframe.asp", requiredText: Object.freeze(["HTML Iframes", "iframe"]) })
]);

export const limitSuiteLimits = Object.freeze({
  compatibilityTimeoutMs: 30_000,
  navigationCount: 100,
  navigationLifetimeMs: 120_000,
  navigationRssLimitMiB: 128,
  leakGrowthLimitMiB: 48,
  concurrentSessions: 2,
  concurrentAggregateRssLimitMiB: 128,
  concurrentSwapGrowthLimitMiB: 64,
  unsupportedTimeoutMs: 25_000,
  forcedTimeoutMs: 1,
  outputBytes: 64 * 1024
});

export function contentMatchesLimitFixture(fixture, content, finalUrl) {
  const text = String(content || "");
  const missingText = fixture.requiredText.filter((expected) => !text.includes(expected));
  const finalUrlMatches = !fixture.finalUrl || String(finalUrl || "") === fixture.finalUrl;
  return { success: missingText.length === 0 && finalUrlMatches, missingText, finalUrlMatches };
}

export function validateLimitSuitePolicy() {
  const expectedCategories = ["react", "vue", "angular", "forms", "modals", "tables", "scrolling", "redirects", "iframes"];
  const categories = new Set(limitFixtures.map((fixture) => fixture.category));
  for (const category of expectedCategories) if (!categories.has(category)) throw new Error(`Limit suite lacks ${category} coverage.`);
  for (const fixture of limitFixtures) {
    const url = new URL(fixture.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Unsafe limit fixture: ${fixture.id}`);
    if (!fixture.requiredText?.length) throw new Error(`Limit fixture has no semantic assertion: ${fixture.id}`);
  }
  if (limitSuiteLimits.navigationCount !== 100) throw new Error("Leak probe must remain exactly 100 navigations.");
  if (limitSuiteLimits.concurrentSessions < 2 || limitSuiteLimits.concurrentSessions > 3) throw new Error("Concurrent session budget must remain between two and three.");
  return true;
}
