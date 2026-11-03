import test from 'node:test';
import assert from 'node:assert/strict';
import { withRootTextRoutes } from '../root-text.js';

test('root routes are idempotent and upgrade legacy handlers', () => {
  const base = 'before\n    const pages = await loadPages();\nafter';
  const updated = withRootTextRoutes(base);
  assert.equal(withRootTextRoutes(updated), updated);
  assert.match(updated, /application\/xml; charset=utf-8/);
  assert.match(updated, /req.method === "HEAD"/);
  const legacy = 'before\n    // roster-root-text\n    if (true) { /* old route */ }\n    const pages = await loadPages();\nafter';
  assert.equal(withRootTextRoutes(legacy), updated);
  assert.throws(() => withRootTextRoutes('unknown'), /not supported/);
});
