import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isReservedPath,
  validateToolWebRoutes
} from "../src/runtime/web/route-validation.js";

async function tempToolDir(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-route-validation-"));
  return path.join(root, name);
}

test("loads valid tool web routes", async () => {
  const toolDir = await tempToolDir("alpha");
  const claimedPaths = new Map();
  const manifest = {
    name: "alpha",
    web: {
      routes: [
        { path: "/alpha", handler: "web/index.js" }
      ]
    }
  };

  const { routes, errors } = validateToolWebRoutes(manifest, toolDir, claimedPaths);

  assert.deepEqual(errors, []);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].toolName, "alpha");
  assert.equal(routes[0].path, "/alpha");
  assert.deepEqual(routes[0].methods, ["GET"]);
  assert.equal(routes[0].public, false);
  assert.equal(routes[0].handlerPath, path.join(toolDir, "web", "index.js"));
});

test("rejects invalid and reserved route paths", async () => {
  const toolDir = await tempToolDir("bad");
  const invalidPaths = ["/", "/health", "/api", "/api/tools", "/telegram-secret", "/has/../dotdot", "relative"];

  for (const routePath of invalidPaths) {
    const { routes, errors } = validateToolWebRoutes({
      name: "bad",
      web: { routes: [{ path: routePath, handler: "web/index.js" }] }
    }, toolDir, new Map());

    assert.equal(routes.length, 0, routePath);
    assert.equal(errors.length, 1, routePath);
  }

  assert.equal(isReservedPath("/telegram-token"), true);
  assert.equal(isReservedPath("/custom"), false);
});

test("rejects route collisions between tools", async () => {
  const firstToolDir = await tempToolDir("first");
  const secondToolDir = await tempToolDir("second");
  const claimedPaths = new Map();

  const first = validateToolWebRoutes({
    name: "first",
    web: { routes: [{ path: "/shared", handler: "web/index.js" }] }
  }, firstToolDir, claimedPaths);

  const second = validateToolWebRoutes({
    name: "second",
    web: { routes: [{ path: "/shared", handler: "web/index.js" }] }
  }, secondToolDir, claimedPaths);

  assert.equal(first.routes.length, 1);
  assert.equal(second.routes.length, 0);
  assert.match(second.errors[0].error, /collides with tool first/);
});

test("rejects handlers outside the tool directory", async () => {
  const toolDir = await tempToolDir("escape");

  const { routes, errors } = validateToolWebRoutes({
    name: "escape",
    web: { routes: [{ path: "/escape", handler: "../outside.js" }] }
  }, toolDir, new Map());

  assert.equal(routes.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /handler must not contain \.\./);
});
