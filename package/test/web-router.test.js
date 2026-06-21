import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebRouter } from "../src/runtime/web/web-router.js";

async function createHandlerFiles() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-web-router-"));
  await mkdir(root, { recursive: true });
  const okHandler = path.join(root, "ok.js");
  const errorHandler = path.join(root, "error.js");

  await writeFile(okHandler, `export async function handleWebRequest(_req, res, context) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ toolName: context.toolName, chatId: context.chatId }));
}
`, "utf8");

  await writeFile(errorHandler, `export async function handleWebRequest() {
  throw new Error("secret stack marker");
}
`, "utf8");

  return { okHandler, errorHandler };
}

function buildRouter({ routes, token = "secret-token", limits, logger } = {}) {
  return createWebRouter({
    getRoutes: () => routes,
    getToken: () => token,
    logger,
    limits,
    buildContext: ({ toolName, chatId }) => ({ toolName, chatId })
  });
}

async function startRouterServer(router) {
  const server = createServer((req, res) => {
    router.dispatch(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

test("protected routes require the shared bearer token", async () => {
  const { okHandler } = await createHandlerFiles();
  const routes = [
    { toolName: "private-tool", path: "/private", methods: ["GET"], public: false, handlerPath: okHandler }
  ];
  const router = createWebRouter({
    getRoutes: () => routes,
    getToken: () => "secret-token",
    buildContext: ({ toolName, chatId }) => ({ toolName, chatId })
  });
  const server = await startRouterServer(router);

  try {
    const rejected = await fetch(`${server.baseUrl}/private`);
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${server.baseUrl}/private?chatId=123`, {
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { toolName: "private-tool", chatId: 123 });
  } finally {
    await server.close();
  }
});

test("public routes do not require a token", async () => {
  const { okHandler } = await createHandlerFiles();
  const routes = [
    { toolName: "public-tool", path: "/public", methods: ["GET"], public: true, handlerPath: okHandler }
  ];
  const router = createWebRouter({
    getRoutes: () => routes,
    getToken: () => "secret-token",
    buildContext: ({ toolName, chatId }) => ({ toolName, chatId })
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/public`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { toolName: "public-tool", chatId: null });
  } finally {
    await server.close();
  }
});

test("disallows undeclared HTTP methods", async () => {
  const { okHandler } = await createHandlerFiles();
  const routes = [
    { toolName: "public-tool", path: "/public", methods: ["GET"], public: true, handlerPath: okHandler }
  ];
  const router = createWebRouter({
    getRoutes: () => routes,
    getToken: () => "secret-token",
    buildContext: ({ toolName, chatId }) => ({ toolName, chatId })
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/public`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  } finally {
    await server.close();
  }
});

test("handler errors do not expose stack traces to clients", async () => {
  const { errorHandler } = await createHandlerFiles();
  const logs = [];
  const routes = [
    { toolName: "error-tool", path: "/error", methods: ["GET"], public: true, handlerPath: errorHandler }
  ];
  const router = createWebRouter({
    getRoutes: () => routes,
    getToken: () => "secret-token",
    logger: { error: (scope, message) => logs.push({ scope, message }) },
    buildContext: ({ toolName, chatId }) => ({ toolName, chatId })
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/error`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.equal(body.includes("secret stack marker"), false);
    assert.equal(body.includes("Error:"), false);
    assert.equal(logs[0].scope, "web");
    assert.match(logs[0].message, /secret stack marker/);
  } finally {
    await server.close();
  }
});

test("core routes take precedence over tool routes", async () => {
  const { okHandler } = await createHandlerFiles();
  const router = buildRouter({
    routes: [
      { toolName: "tool", path: "/health", methods: ["GET"], public: true, handlerPath: okHandler }
    ]
  });
  router.registerCoreRoute({
    method: "GET",
    path: "/health",
    handler: (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("core-health");
    }
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "core-health");
  } finally {
    await server.close();
  }
});

test("unknown paths return a plain ok response", async () => {
  const router = buildRouter({ routes: [] });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/does-not-exist`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await server.close();
  }
});

test("rejects request bodies over the configured limit", async () => {
  const { okHandler } = await createHandlerFiles();
  const router = buildRouter({
    routes: [
      { toolName: "upload-tool", path: "/upload", methods: ["POST"], public: true, handlerPath: okHandler }
    ],
    limits: { bodyLimitBytes: 8 }
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/upload`, {
      method: "POST",
      body: "x".repeat(64)
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("accepts the shared token from the query string", async () => {
  const { okHandler } = await createHandlerFiles();
  const router = buildRouter({
    routes: [
      { toolName: "private-tool", path: "/private", methods: ["GET"], public: false, handlerPath: okHandler }
    ]
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/private?token=secret-token`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("rejects wrong tokens and locks down protected routes without a configured token", async () => {
  const { okHandler } = await createHandlerFiles();
  const protectedRoute = { toolName: "private-tool", path: "/private", methods: ["GET"], public: false, handlerPath: okHandler };

  const wrongTokenServer = await startRouterServer(buildRouter({ routes: [protectedRoute] }));
  try {
    const response = await fetch(`${wrongTokenServer.baseUrl}/private`, {
      headers: { Authorization: "Bearer wrong-token" }
    });
    assert.equal(response.status, 401);
  } finally {
    await wrongTokenServer.close();
  }

  const noTokenServer = await startRouterServer(buildRouter({ routes: [protectedRoute], token: "" }));
  try {
    const response = await fetch(`${noTokenServer.baseUrl}/private`, {
      headers: { Authorization: "Bearer anything" }
    });
    assert.equal(response.status, 401);
  } finally {
    await noTokenServer.close();
  }
});

test("passes a non-numeric chatId through to the handler context", async () => {
  const { okHandler } = await createHandlerFiles();
  const router = buildRouter({
    routes: [
      { toolName: "public-tool", path: "/public", methods: ["GET"], public: true, handlerPath: okHandler }
    ]
  });
  const server = await startRouterServer(router);

  try {
    const response = await fetch(`${server.baseUrl}/public?chatId=team-7`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { toolName: "public-tool", chatId: "team-7" });
  } finally {
    await server.close();
  }
});
