import { Agent, Runner, tool, MCPServerStreamableHttp, Usage } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall, modelResponder } from '@openai/agents/testing';

export const openAIAgentsPolicy = 'Report the release status accurately. Preserve the native policy and memory.';
export const nativeUsage = { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } };
export const response = (output, rawUsage = nativeUsage) => ({ output,
  usage: new Usage(rawUsage ?? undefined), ...(rawUsage ? { rawUsage } : {}) });

/** Real Agent/Runner and the SDK's provider-level ScriptedModel. No credentials or network model calls. */
export function nativeOpenAIAgents({ failure, respond, usage = nativeUsage, instructions = openAIAgentsPolicy,
  agentOptions = {}, runnerOptions = {} } = {}) {
  const model = new ScriptedModel();
  const step = modelResponder(async call => {
    model.enqueue(step);
    if (failure) throw failure;
    if (respond) return respond(call);
    const text = /Verified/.test(call.request.systemInstructions ?? '') ? 'Verified. The release is ready.' : 'The release is ready.';
    return response([assistantMessage(text)], usage);
  });
  model.enqueue(step);
  const agent = new Agent({ name: 'Native release agent', instructions, model, modelSettings: { preserveRawUsage: true }, ...agentOptions });
  const runner = new Runner({ tracingDisabled: true, ...runnerOptions });
  return { agent, runner, nativeRun: runner.run.bind(runner), model, policy: instructions,
    get calls() { return model.calls; } };
}

/** Host-owned tool routing and an actual native MCP connection to its explicit workflow bridge. */
export async function nativeOpenAIAgentsWorkflow({ bridge, execute = () => ({ ready: true }), serverName = 'agentrun' } = {}) {
  const toolCalls = [];
  const nativeTool = tool({ name: 'mcp__backend__status', description: 'Read release readiness.',
    parameters: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'], additionalProperties: false },
    strict: true, errorFunction: null, execute: async (args, _context, details) => {
      toolCalls.push({ name: 'mcp__backend__status', input: args });
      return JSON.stringify(await execute(args, { signal: details.signal }));
    } });
  const mcp = bridge ? new MCPServerStreamableHttp({ name: serverName, url: bridge.url,
    requestInit: { headers: bridge.headers }, errorFunction: null }) : undefined;
  if (mcp) {
    await mcp.connect();
    const call = mcp.callTool.bind(mcp);
    mcp.callTool = async (name, args, ...rest) => {
      toolCalls.push({ name: `mcp_${serverName}__${name}`, input: args });
      return call(name, args, ...rest);
    };
  }
  const fixture = nativeOpenAIAgents({ agentOptions: { tools: [nativeTool], mcpServers: mcp ? [mcp] : [],
    mcpConfig: { includeServerInToolNames: true, errorFunction: null } }, respond: call => {
    const last = call.request.input.at(-1);
    if (last?.type === 'function_call_result') {
      const text = typeof last.output === 'string' ? last.output : last.output?.type === 'text' ? last.output.text : JSON.stringify(last.output);
      // Native MCP returns text blocks; the answer copies the bridge's exact public text.
      let output = text;
      try { const blocks = JSON.parse(text); if (Array.isArray(blocks)) output = blocks.map(block => block.text ?? '').join(''); } catch {}
      return response([assistantMessage(output)]);
    }
    const context = call.request.systemInstructions ?? '';
    const capability = context.match(/Supply capability "([a-f0-9]+)"/)?.[1];
    const catalog = context.match(/Approved workflows for this task \(reference data\):\n([^\n]+)/)?.[1];
    const workflow = catalog ? JSON.parse(catalog)[0] : undefined;
    const name = capability && workflow ? `mcp_${serverName}__learned_workflow` : nativeTool.name;
    const args = capability && workflow ? { capability, name: workflow.name, input: { release: 'current' } } : { release: 'current' };
    return response([functionCall(name, args, { callId: `tool-${call.index}` })]);
  } });
  return { ...fixture, get calls() { return fixture.model.calls; }, toolCalls, mcp,
    close: async () => { if (mcp) await mcp.close(); } };
}
