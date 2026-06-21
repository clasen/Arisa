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
