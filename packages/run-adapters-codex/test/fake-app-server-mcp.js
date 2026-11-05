// The fake app-server's remote MCP client (test/fake-app-server.mjs, patch 017-mcp-servers hooks it in): ours, kept out of
// the vendored file so its patch stays a hook. It calls a config.toml `mcp_servers` tool as Codex 0.164 does:
// - `mcp <server> <tool> <json args>`: `item/started` for an mcpToolCall, then `tools/call` at once with `_meta.callId`
//   (the item's id), a function_call in the server's namespace and its output in the rollout;
// - a required server that does not start (`FAKE_CODEX_MCP_START=fail`) fails `thread/start` (mcpDown);
// - `outputs` says the tool outputs the thread holds.
// The fake hands each its own pieces (`config`, `table`, the thread, `write`, `notify`, `say`), read at the call.
import { randomUUID } from 'node:crypto';

/** A config.toml MCP server, and one request to it as Codex's client sends it: the answer's message (JSON, or SSE's last). */
const mcpServer = (table, name) => ((t) => t ? { url: /^url = "([^"]+)"/m.exec(t)?.[1], key: process.env[/^bearer_token_env_var = "([^"]+)"/m.exec(t)?.[1]] ?? '', tools: /^enabled_tools = \[(.*)\]$/m.exec(t)?.[1] ?? '' } : undefined)(table(`mcp_servers.${name}`));
const mcpPost = (server, message) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${server.key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) })
  .then(async (res) => { const text = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status}`); return JSON.parse(text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data: ')).at(-1).slice(6)); });

/** The first required MCP server that does not start, as Codex says it. */
export async function mcpDown({ config, table }) {
  for (const [, name] of config().matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)) {
    const error = process.env.FAKE_CODEX_MCP_START === 'fail' ? 'handshaking with MCP server failed' : await mcpPost(mcpServer(table, name), { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }).then(() => null, (err) => err.message);
    if (error && /^required = true$/m.test(table(`mcp_servers.${name}`))) return `required MCP servers failed to initialize: ${name}: ${error}`;
  }
}

/** One `outputs` or `mcp …` turn: what the turn says last (the fake says it). */
export async function mcpTurn(trimmed, turnId, { thread, write, notify, say, table }) {
  if (trimmed === 'outputs') return thread.lines.filter((l) => l.payload?.type === 'function_call_output').map((l) => l.payload.output).join(' | ') || 'no outputs';
  const [, name, tool, args] = /^mcp\s+(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  await say(turnId, `Calling ${name} ${tool}.`);
  write('response_item', { type: 'function_call', name: tool, namespace: `mcp__${name}`, arguments: args, call_id: callId });
  const item = { type: 'mcpToolCall', id: callId, server: name, tool, status: 'inProgress', arguments: JSON.parse(args) };
  notify('item/started', { threadId: thread.id, turnId, item });
  const answer = mcpServer(table, name)?.tools.includes(`"${tool}"`) ? await mcpPost(mcpServer(table, name), { method: 'tools/call', params: { _meta: { callId }, name: tool, arguments: item.arguments } }).catch((err) => ({ error: err })) : { error: { message: 'no such tool' } };
  const out = answer.error?.message ?? answer.result.content.map((c) => c.text).join('');
  write('response_item', { type: 'function_call_output', call_id: callId, output: out });
  notify('item/completed', { threadId: thread.id, turnId, item: { ...item, status: answer.error || answer.result.isError ? 'failed' : 'completed', result: answer.result ?? null, error: answer.error ? { message: out } : null } });
  return `${tool} ${answer.error ? 'failed' : 'returned'}: ${out.slice(0, 200)} (item ${callId})`;
}
