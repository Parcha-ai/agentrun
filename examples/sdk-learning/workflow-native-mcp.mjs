// The example backend's existing read-only tools, served to either native SDK over local MCP.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function serveReleaseTools(tools) {
  const credential = randomUUID(), connections = new Set();
  let url;
  const http = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.host !== new URL(url).host || req.headers.origin || req.headers.authorization !== `Bearer ${credential}`) {
      res.writeHead(403).end(); return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { res.writeHead(400).end(); return; }
    const server = new Server({ name: 'release', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
      name: tool.name.replace(/^mcp:release\//, ''), description: tool.description, inputSchema: tool.input_schema,
      ...(tool.output_schema ? { outputSchema: tool.output_schema } : {}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find(tool => tool.name === `mcp:release/${request.params.name}`);
      if (!tool) throw new Error('Unknown release tool.');
      const result = await tool.execute(request.params.arguments ?? {}, { signal: extra.signal,
        runId: 'native', idempotencyKey: randomUUID() });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    connections.add(server);
    res.on('close', () => { connections.delete(server); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${http.address().port}/mcp`;
  return { url, headers: { Authorization: `Bearer ${credential}` },
    async close() {
      await Promise.all([...connections].map(server => server.close()));
      const closed = new Promise(resolve => http.close(resolve)); http.closeAllConnections(); await closed;
    },
  };
}
