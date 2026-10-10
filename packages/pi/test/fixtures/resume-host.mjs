// A minimal Pi host for the resume test: it loads the compiled extension with two ledgered host tools and a judge that
// can hang, keeps the session branch in a file, and runs one slash command. The test kills it, then runs it again.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentRunExtension } from '../../dist/extension.js';

const [cwd, command, hang] = process.argv.slice(2);
const ledger = join(cwd, 'ledger.txt'), branchFile = join(cwd, 'branch.json');
const branch = existsSync(branchFile) ? JSON.parse(readFileSync(branchFile, 'utf8')) : [];
const tool = name => ({
  name, label: name, description: `Ledgered ${name}.`,
  parameters: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string' } } },
  async execute() { appendFileSync(ledger, `${name}\n`); return { content: [{ type: 'text', text: name }], details: { name } }; },
});
const commands = new Map(), tools = new Map(), events = new Map(), messages = [];
const pi = {
  registerTool: t => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c), registerEntryRenderer: () => {},
  appendEntry: (customType, data) => { branch.push({ type: 'custom', customType, data }); writeFileSync(branchFile, JSON.stringify(branch)); },
  on: (n, h) => events.set(n, h), getActiveTools: () => [], getCommands: () => [{ name: 'skill:agentrun-author', source: 'skill' }],
  getAllTools: () => [], getThinkingLevel: () => 'low', sendMessage: m => messages.push(m), sendUserMessage: () => {},
};
createAgentRunExtension({
  hostTools: () => [tool('first'), tool('second')],
  createJudge: () => async () => {
    appendFileSync(ledger, 'judge\n');
    if (hang === 'hang') { writeFileSync(join(cwd, 'armed'), ''); await new Promise(() => {}); }
    return { answers: { supported: { type: 'noul', noul: 1 } } };
  },
})(pi);
const ctx = { cwd, model: undefined, thinkingLevel: 'low', signal: new AbortController().signal, hasUI: false, mode: 'print',
  sessionManager: { getSessionId: () => 'resume-test', getBranch: () => branch, getSessionFile: () => undefined },
  ui: { setStatus() {}, setWidget() {}, custom: async () => undefined }, modelRegistry: { getAll: () => [], streamSimple() { throw new Error('no model'); } } };
await events.get('session_start')?.({}, ctx);
if (!branch.length) await tools.get('agentrun').execute('inspect', { action: 'inspect', workflow: JSON.parse(readFileSync(join(cwd, 'workflow.json'), 'utf8')), input: {} }, undefined, undefined, ctx);
await commands.get('agentrun').handler(command, ctx);
const last = messages.at(-1);
console.log(JSON.stringify({ status: last?.details?.status, output: last?.details?.output, error: last?.details?.error, content: last?.content?.slice(0, 300) }));
process.exit(0);
