import assert from 'node:assert/strict';
import test from 'node:test';
import { Compile } from 'typebox/compile';
import { createAgentRunExtension } from '../dist/extension.js';
import { toolInputProblems } from '../dist/tool-input-error.js';

const parameters = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const definition = args => ({ v: 2, name: 'Fictional tool-input diagnostics',
  schemas: { Result: { type: 'object' } }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'call', label: 'read-fictional-record', via: 'tool', tool: 'lookup', args, out: 'Result', as: 'result', deadline_s: 1 },
});
const harness = execute => {
  const tools = new Map(), events = new Map(), renderers = new Map(), branch = []; let attempts = 0;
  const ctx = { cwd: process.cwd(), hasUI: false, signal: new AbortController().signal,
    sessionManager: { getSessionId: () => 'fictional-input-diagnostic', getBranch: () => branch, getSessionFile: () => undefined }, modelRegistry: { getAll: () => [] } };
  createAgentRunExtension({ hostTools: () => [{ name: 'lookup', label: 'Fictional lookup', description: 'A test fixture, not a live source.', parameters, execute }], onToolAttempt: () => attempts++ })({
    registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on: (name, listener) => events.set(name, listener),
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data: structuredClone(data) }),
    getCommands: () => [{ name: 'skill:agentrun-author', source: 'skill' }], sendMessage() {}, getThinkingLevel: () => 'low',
  });
  return { call: args => tools.get('agentrun').execute('fixture', args, ctx.signal, undefined, ctx), attempts: () => attempts,
    close: () => events.get('session_shutdown')() };
};

test('native direct-tool type rejection names the node and schema without executing or leaking values', async () => {
  let executions = 0;
  const app = harness(async () => { executions++; throw new Error('must not execute'); });
  try {
    await app.call({ action: 'inspect', workflow: definition({ query: { secret: 'PRIVATE_SUBMITTED_VALUE' } }) });
    const result = await app.call({ action: 'run' });
    assert.equal(result.details.status, 'failed');
    assert.equal(result.details.error.code, 'tool_input_invalid');
    assert.equal(result.details.error.stage, 'read-fictional-record');
    assert.match(result.details.error.problems.join(' '), /properties\/query.*declared type/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SUBMITTED_VALUE/);
    assert.equal(executions, 0); assert.equal(app.attempts(), 1);
  } finally { await app.close(); }
});

test('unknown submitted keys are omitted and ordinary tool exceptions remain opaque', async () => {
  const app = harness(async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); });
  try {
    await app.call({ action: 'inspect', workflow: definition({ query: 'allowed', PRIVATE_SUBMITTED_KEY: 'private' }) });
    const invalid = await app.call({ action: 'run' });
    assert.equal(invalid.details.error.code, 'tool_input_invalid');
    assert.match(invalid.details.error.problems.join(' '), /additional properties/);
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_SUBMITTED_KEY|private/);
    await app.call({ action: 'inspect', workflow: definition({ query: 'allowed' }) });
    const failed = await app.call({ action: 'run' });
    assert.equal(failed.details.error.code, 'execution_failed');
    assert.equal(failed.details.error.stage, 'read-fictional-record');
    assert.match(failed.content[0].text, /registered tool call failed/);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_DETAIL/);
    assert.equal(app.attempts(), 2);
  } finally { await app.close(); }
});

test('safe schema problems are bounded and retain no raw validator messages, params or instance paths', () => {
  const validator = Compile(parameters);
  assert.match(toolInputProblems(validator.Errors({})).join(' '), /missing required properties/);
  const errors = Array.from({ length: 20 }, () => ({ keyword: 'type', schemaPath: '#/properties/' + 'x'.repeat(1000),
    instancePath: '/PRIVATE_DYNAMIC_KEY', message: 'PRIVATE_RAW_MESSAGE', params: { value: 'PRIVATE_VALUE' } }));
  const problems = toolInputProblems(errors);
  assert.equal(problems.length, 8); assert(problems.every(value => value.length <= 500));
  assert.doesNotMatch(JSON.stringify(problems), /PRIVATE_/);
});

test('a corrected inspected argument completes through the same native tool and accounting path', async () => {
  let executions = 0;
  const app = harness(async (_id, args) => {
    executions++; return { content: [{ type: 'text', text: args.query }], details: { text: args.query } };
  });
  try {
    await app.call({ action: 'inspect', workflow: definition({ query: false }) });
    assert.equal((await app.call({ action: 'run' })).details.error.code, 'tool_input_invalid');
    await app.call({ action: 'inspect', workflow: definition({ query: 'Fictional repaired input' }) });
    const corrected = await app.call({ action: 'run' });
    assert.equal(corrected.details.status, 'complete');
    assert.equal(corrected.details.output.details.text, 'Fictional repaired input');
    assert.equal(executions, 1); assert.equal(app.attempts(), 2);
  } finally { await app.close(); }
});
