import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { StateGraph, MessagesAnnotation, START, END, MemorySaver, InMemoryStore, getStore, interrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const langGraphPolicy = 'Report the release status accurately. Preserve the native policy and memory.';
export const langGraphAdapters = {
  instructions: langGraphPolicy,
  inputText: input => input.messages.at(-1).content,
  withLearning: (input, context) => ({ ...input, messages: [{ role: 'user', content: context }, ...input.messages] }),
  answerText: output => output.messages.at(-1).content,
};

/** An actual native graph and BaseChatModel; only the provider response is scripted. No model credentials. */
export function nativeLangGraph({ checkpoint = true, pause = false, failure, respond, usage = {
  input_tokens: 20, output_tokens: 6, total_tokens: 26, input_token_details: { cache_read: 8, cache_creation: 4 },
} } = {}) {
  const calls = [], toolCalls = [], memories = [], nodeOptions = [], checkpointer = checkpoint ? new MemorySaver() : undefined;
  const store = new InMemoryStore(), policy = new SystemMessage(langGraphPolicy);
  class ScriptedModel extends BaseChatModel {
    constructor() { super({}); }
    _llmType() { return 'agentrun-scripted-langgraph'; }
    async _generate(messages, options, runManager) {
      calls.push({ messages, options, runManager });
      if (failure) throw failure;
      // The second task gets its prefix only if accepted learning reached this native model request.
      const source = messages.map(message => message.content).join('\n');
      const content = respond ? await respond(messages, options) :
        /Verified/.test(source) ? 'Verified. The release is ready.' : 'The release is ready.';
      const message = new AIMessage({ content, ...(usage ? { usage_metadata: usage } : {}) });
      return { generations: [{ text: typeof content === 'string' ? content : '', message }] };
    }
  }
  const model = new ScriptedModel();
  const releaseStatus = tool(async () => {
    toolCalls.push('release_status');
    return 'ready';
  }, { name: 'release_status', description: 'Read release status.', schema: { type: 'object', properties: {} } });
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('status', async (_state, options) => {
      await releaseStatus.invoke({}, options);
      return {};
    })
    .addNode('agent', async (state, options) => {
      nodeOptions.push(options);
      const nativeStore = getStore();
      memories.push(structuredClone(await nativeStore.get(['native'], 'preference')));
      if (pause) interrupt('Native approval required.');
      return { messages: [await model.invoke([policy, ...state.messages], options)] };
    })
    .addEdge(START, 'status').addEdge('status', 'agent').addEdge('agent', END)
    .compile({ checkpointer, store });
  return { graph, calls, toolCalls, memories, nodeOptions, checkpointer, store, policy, model };
}

/** A host-owned graph with native tool routing and an explicit connection to its existing workflow bridge. */
export async function nativeLangGraphWorkflow({ bridge, execute = () => ({ ready: true }), checkpoint = true } = {}) {
  const calls = [], toolCalls = [], memories = [], checkpointer = checkpoint ? new MemorySaver() : undefined;
  const store = new InMemoryStore(), policy = new SystemMessage(langGraphPolicy);
  const mcp = new Client({ name: 'langgraph-learning-test', version: '1.0.0' });
  if (bridge) await mcp.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: bridge.headers } }));
  const nativeTool = tool(async (args, options) => {
    toolCalls.push({ name: 'mcp__backend__status', input: args });
    return JSON.stringify(await execute(args, { signal: options.signal }));
  }, { name: 'mcp__backend__status', description: 'Read release readiness.',
    schema: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] } });
  const learnedTool = tool(async (args, options) => {
    toolCalls.push({ name: 'mcp__agentrun__learned_workflow', input: args });
    const result = await mcp.callTool({ name: 'learned_workflow', arguments: args }, undefined, { signal: options.signal });
    if (result.isError) throw new Error('The workflow bridge refused the native tool call.');
    return result.content.map(part => part.type === 'text' ? part.text : '').join('');
  }, { name: 'mcp__agentrun__learned_workflow', description: 'Run an approved workflow with the current native task capability.',
    schema: { type: 'object', required: ['capability', 'name', 'input'], additionalProperties: false,
      properties: { capability: { type: 'string' }, name: { type: 'string' }, input: { type: 'object' } } } });
  const nativeTools = bridge ? [nativeTool, learnedTool] : [nativeTool];
  class WorkflowModel extends BaseChatModel {
    constructor() { super({}); }
    _llmType() { return 'agentrun-scripted-langgraph-tools'; }
    bindTools(tools) { this.nativeTools = tools; return this; }
    async _generate(messages, options) {
      calls.push({ messages, options });
      const last = messages.at(-1), context = messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
      let message;
      if (last.getType() === 'tool') message = new AIMessage(last.content);
      else {
        const capability = context.match(/Supply capability "([a-f0-9]+)"/)?.[1];
        const catalog = context.match(/Approved workflows for this task \(reference data\):\n([^\n]+)/)?.[1];
        const workflow = catalog ? JSON.parse(catalog)[0] : undefined;
        const name = capability && workflow ? learnedTool.name : nativeTool.name;
        const args = capability && workflow ? { capability, name: workflow.name, input: { release: 'current' } } : { release: 'current' };
        message = new AIMessage({ content: '', tool_calls: [{ id: `tool-${calls.length}`, name, args, type: 'tool_call' }] });
      }
      message.usage_metadata = { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_token_details: { cache_read: 0, cache_creation: 0 } };
      return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
    }
  }
  const model = new WorkflowModel().bindTools(nativeTools);
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', async (state, options) => {
      memories.push(structuredClone(await getStore().get(['native'], 'preference')));
      return { messages: [await model.invoke([policy, ...state.messages], options)] };
    })
    .addNode('tools', new ToolNode(nativeTools, { handleToolErrors: false }))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', state => state.messages.at(-1).tool_calls?.length ? 'tools' : END, ['tools', END])
    .addEdge('tools', 'agent').compile({ checkpointer, store });
  return { graph, calls, toolCalls, memories, checkpointer, store, policy, model, close: () => mcp.close() };
}
