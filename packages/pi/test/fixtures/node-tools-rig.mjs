// A root agent with its own rules, a learning extension with its own section, and the host's tools (a fetch, the
// root's final answer, and tools shaped like the Stagehand browser's), over a scripted model that has it inspect and run
// a workflow whose agent node names the tools it uses. The run is a task of the root's conversation, so each node's
// conversation is one that task owns. Returns what the root and the node were sent.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section } from '@earendil-works/pi-durable';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowTool, nodeRunner, taskScope } from '@parcha/agentrun-pi/durable';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultOf } from './pi-version.mjs';

export const MODEL = { provider: 'faux', modelId: 'faux-1' };
/** The root agent's own rules, as a project's AGENTS.md gives them. */
export const ROOT_RULES = 'Project rules (AGENTS.md): classify the company, then call answer once. Rule mark R-7Q2.';
/** What the learning extension puts in the root's prompt. */
export const LEARNED = 'Learned so far: read the annual report first. Lesson mark L-4K9.';
/** The rules the host gives a node's conversation. */
export const NODE_RULES = 'You do one step of a workflow. Use only the tools you are given, then deliver its record.';

const open = { type: 'object', additionalProperties: true };
const tool = (name, description, parameters = open) => defineTool({ name, description, parameters, execute: async () => resultOf([{ type: 'text', text: `${name} ran` }]) });

/** Shaped like pi-browser's Stagehand tools: a snapshot of the page's accessibility tree, a run of code or of actions
 *  by snapshot ID, a screenshot, and a read of the page. */
export const STAGEHAND = [
  tool('snapshot', 'Capture the active page\'s Stagehand accessibility tree.', { type: 'object', additionalProperties: false, properties: { includeIframes: { type: 'boolean', default: true } } }),
  tool('run', 'Browse and automate websites in the Stagehand browser: JavaScript against the page, or actions by snapshot ID.', {
    type: 'object', additionalProperties: false,
    properties: {
      code: { type: 'string' },
      actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['op', 'id'], properties: { op: { type: 'string', enum: ['click', 'fill', 'select'] }, id: { type: 'string' }, value: { type: 'string' } } } },
    },
  }),
  tool('screenshot', 'Capture a screenshot of the active page.', { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['png', 'jpeg'] }, fullPage: { type: 'boolean' } } }),
  tool('browser_read', 'Read the active page.', { type: 'object', additionalProperties: false, properties: { what: { type: 'string', enum: ['markdown', 'text', 'html', 'url', 'title'] } } }),
];
const fetchPage = tool('fetch_page', 'Fetch one web page as text.', { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' } } });
const answer = tool('answer', 'Give the final answer, once.');
/** The host's tools: the root agent is offered them all; a workflow names the ones a node uses. */
export const HOST_TOOLS = [...STAGEHAND, fetchPage, answer];
export const hostTools = defineExtension({ name: 'host.tools', tools: HOST_TOOLS });
export const learning = defineExtension({ name: 'host.learn', tools: [tool('learn', 'Keep a lesson.')], sections: [section('learned', () => LEARNED)] });

const SUMMARY = { type: 'object', additionalProperties: false, required: ['business'], properties: { business: { type: 'string' } } };
/** The tools the node names: three of the four Stagehand-shaped tools and the fetch, not the screenshot or the answer. */
export const NODE_TOOLS = ['snapshot', 'run', 'browser_read', 'fetch_page'];
export const WORKFLOW = {
  v: 2, name: 'read-site',
  schemas: {
    Input: { type: 'object', additionalProperties: false, required: ['website'], properties: { website: { type: 'string' } } },
    Summary: SUMMARY,
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Summary', path: 'summary' },
  root: { node: 'agent', label: 'read the site', instructions: 'Open the site and say what the company makes.', tools: NODE_TOOLS, state: { website: '{website}' }, out: 'Summary', as: 'summary' },
};
const INPUT = { website: 'https://www.acme.example/' };

const call = (args) => fauxAssistantMessage([fauxToolCall('agentrun', args)], { stopReason: 'toolUse' });
const sectionsOf = (messages) => messages.find((message) => message.role === 'system')?.sections ?? {};
const toolsOf = (messages) => messages.flatMap((message) => message.toolsAdded ?? []);
/** A node's conversation is the one whose prompt has the runner's `task` section. */
const isNode = (messages) => 'task' in sectionsOf(messages);

/**
 * Runs the workflow from the root agent, with `agent(node, byName)` as the node host's agent (`byName` maps the names a
 * node gives to the host's tools). Returns the run's outcome and, for the root's first request and the node's first,
 * the prompt sections, the tools offered (each name with its parameters) and the whole request as JSON.
 */
export async function runNodeTools(agent) {
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-node-tools-'));
  const requests = [];
  const root = [call({ action: 'inspect', workflow: WORKFLOW, input: INPUT }), call({ action: 'run' }), fauxAssistantMessage('done')];
  const faux = fauxProvider();
  // One response per request, decided by whose request it is: the node delivers its record, the root follows its script.
  faux.setResponses(Array.from({ length: root.length + 1 }, () => async (context) => {
    const messages = JSON.parse(JSON.stringify(context.messages));
    requests.push(messages);
    return isNode(messages) ? fauxAssistantMessage([fauxToolCall('submit', { business: 'Acme makes valves.' })], { stopReason: 'toolUse' }) : root.shift();
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const byName = (names) => names.map((name) => {
    const found = HOST_TOOLS.find((offered) => offered.name === name);
    if (!found) throw new Error(`no host tool ${name}`);
    return found;
  });
  const nodes = nodeRunner({ agent: (node) => agent(node, byName) });
  const workflowTool = createWorkflowTool({
    projectDir: mkdtempSync(join(dir, 'project-')),
    tools: HOST_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })),
    task: {
      options: () => ({ files: workspaceFiles(mkdtempSync(join(dir, 'cwd-'))) }),
      run: (invocation) => ({ adapters: { runNode: nodes.on(taskScope(invocation.runtime), invocation.context).runNode }, durableNodes: true }),
    },
  });
  const registry = createRegistry();
  for (const extension of [nodes.extension, learning, hostTools, workflowTool.extension]) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const conversation = await harness.root(ctx, { agent: { model: MODEL, instructions: ROOT_RULES, extensions: [learning, hostTools, workflowTool.extension] } });
    await (await conversation.submit({ type: 'input', content: 'Read the site and say what Acme makes.', requestId: 'ask-1' }, ctx)).wait(ctx);
    const answers = requests.at(-1).filter((message) => message.role === 'toolResult').map((message) => JSON.parse(message.content.map((block) => block.text ?? '').join('')));
    const seen = (messages) => messages && { sections: sectionsOf(messages), tools: toolsOf(messages).map(({ name, parameters }) => ({ name, parameters })), json: JSON.stringify(messages) };
    return { outcome: answers.at(-1)?.outcome, root: seen(requests.find((messages) => !isNode(messages))), node: seen(requests.find(isNode)), requests: requests.length };
  } finally {
    await harness.close(ctx);
    rmSync(dir, { recursive: true, force: true });
  }
}
