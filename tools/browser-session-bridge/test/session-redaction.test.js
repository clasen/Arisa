import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { redactStoredCookieValues } from "../session-redaction.js";

test("redacts stored cookie values reflected by a target page", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "bridge-redaction-"));
  try {
    await mkdir(path.join(stateDir, "sessions"));
    await writeFile(path.join(stateDir, "sessions", "example.com.json"), JSON.stringify({
      cookies: [{ name: "sid", value: "private-cookie-value" }]
    }));
    const page = await redactStoredCookieValues({
      stateDir,
      resourceId: "example.com",
      page: { engine: "lightpanda", title: "private-cookie-value", text: "sid=private-cookie-value" }
    });
    assert.equal(page.title, "[redacted cookie]");
    assert.equal(page.text, "sid=[redacted cookie]");
    assert.equal(page.engine, "lightpanda");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
