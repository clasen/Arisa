export async function handleWebRequest(_req, res, context) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Arisa Web Hello</title>
  </head>
  <body>
    <main>
      <h1>Hello from ${context.toolName}</h1>
      <p>This page is served by an installed Arisa tool.</p>
    </main>
  </body>
</html>`);
}
