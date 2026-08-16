import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function withMcpClient({ endpoint, accessToken, fetchFn }, operation) {
  const client = new Client({ name: "arisa-mcp-client", version: "0.1.0" }, { capabilities: {} });
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: fetchFn,
    requestInit: { headers }
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await transport.close().catch(() => {});
  }
}

export async function listMcpTools(options) {
  return withMcpClient(options, (client) => client.listTools());
}

export async function callMcpTool(options, name, argumentsValue) {
  return withMcpClient(options, (client) => client.callTool({ name, arguments: argumentsValue || {} }));
}
