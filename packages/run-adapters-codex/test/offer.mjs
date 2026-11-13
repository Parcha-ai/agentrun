// What one request to the model offers it, in either of the two shapes the pinned Codex sends. Written for AgentRun.
//
// A model Codex's bundled catalog lists as `tool_mode: code_mode_only` (gpt-6-luna, gpt-6.1-sol, every current OpenAI
// model) is sent the Responses Lite shape: no `tools` field, but an `additional_tools` input item whose `functions`
// namespace holds Codex's code-mode `exec` and `wait`. Every tool the model can call (the host's, `submit`, Codex's own
// readers) is a section of exec's description, `### \`name\``, its arguments a TypeScript declaration. A model the
// catalog does not list (a gateway's own id, `classic-test` here) is sent the classic shape: each tool in `tools`, with
// its JSON Schema as `parameters`.

/** A model id no Codex catalog lists: Codex sends it the classic shape. */
export const CLASSIC_MODEL = 'classic-test';

/** The code-mode offer of `body`: the top-level `tools` (absent in code mode), how many `additional_tools` items it
 *  carries, the `functions` namespace's tool names, and each nested tool's section of exec's description by name. */
export function codeModeOffer(body) {
  const items = (body?.input ?? []).filter((item) => item?.type === 'additional_tools');
  const functions = items.flatMap((item) => item.tools ?? []).find((namespace) => namespace?.name === 'functions');
  const exec = functions?.tools?.find((tool) => tool.name === 'exec');
  const nested = new Map();
  for (const m of String(exec?.description ?? '').matchAll(/^### `([^`]+)`\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/gm)) nested.set(m[1], m[2]);
  return { tools: body?.tools, items: items.length, namespace: functions?.tools?.map((tool) => tool.name), nested };
}

/** Codex's own nested tools in code mode with the built-ins off: its MCP resource readers (no MCP server here, so
 *  they read nothing) and its clock. */
export const CODEX_NESTED = Object.freeze(['clock__curr_time', 'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource']);

/** The nested tools of `body` that are not Codex's own, sorted. */
export const hostNested = (body) => [...codeModeOffer(body).nested.keys()].filter((name) => !CODEX_NESTED.includes(name)).sort();

/** A code-mode `exec` call running `js`. */
export const exec = (callId, js) => ({ type: 'custom_tool_call', name: 'exec', input: js, call_id: callId });
