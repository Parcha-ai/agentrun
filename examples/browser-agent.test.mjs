// The browser agent: its examples, its instructions, the lead it picks, and a run on fakes ($0, no key, no network) that
// leaves a valid recording with the task as the workflow's input and no frame of the fake browser.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { demo } from '@parcha/agentrun-reference';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { exampleAt, inputOf, INSTRUCTIONS, workflow } from './browser-agent/agent.ts';
import { chooseLead } from './browser-agent/live.ts';
import { argvFor, options } from './browser-agent/run.ts';

const EXAMPLES = ['dropdown-handoff'];
const scratch = async (t) => { const tmp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'browser-agent-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
const lines = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('each example is a one-line task and a README; nothing in it is code', () => {
  for (const name of EXAMPLES) {
    const example = exampleAt(name);
    assert.ok(example.question.length > 20 && !example.question.includes('\n'), `${name}: one line in plain words`);
    assert.ok(existsSync(join(example.dir, 'README.md')));
    assert.deepEqual(readdirSync(example.dir).filter((file) => /\.(m?[jt]s)$/.test(file)), [], `${name}: no code in the folder`);
  }
});

test('the agent is one node, thinking at medium, its task in its state; its instructions say read before and after, and hand a person\'s step over', () => {
  const [node, ...more] = workflow.root.steps;
  assert.deepEqual(more, []);
  assert.deepEqual([node.node, node.thinking, node.state], ['agent', 'medium', { question: '{question}' }]);
  assert.equal(node.tools, undefined, 'every tool the run installs: the browser\'s, with browser_request_handoff when the host has a person to reach');
  assert.match(INSTRUCTIONS, /Read a page before you act on it, and read it again after you change anything/);
  assert.match(INSTRUCTIONS, /browser_request_handoff/);
  assert.match(INSTRUCTIONS, /Never do their step for them/);
});

test('an example folder becomes the run\'s input, and the lead is the default when a gateway serves it', () => {
  assert.deepEqual(inputOf(exampleAt('dropdown-handoff')), { question: exampleAt('dropdown-handoff').question, example: 'dropdown-handoff' });
  const argv = argvFor(['examples/dropdown-handoff', '--live']);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--input') + 1]).example, 'dropdown-handoff');
  assert.deepEqual(chooseLead({ MODEL_BASE_URL: 'http://gateway.test/v1' }), { provider: 'google', modelId: 'gemini-3.8-flash' });
  assert.deepEqual(chooseLead({ OPENAI_API_KEY: 'not-a-secret' }), { provider: 'openai', modelId: 'gpt-6-luna' });
  assert.throws(() => chooseLead({}), /--live needs a model key/);
});

test('on fakes the scripted lead reads the page the browser opens on and answers; the recording is valid, holds the task, and no frame of the fake browser', { timeout: 300_000 }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await demo({ ...options, argv: ['--dir', join(tmp, 'run'), '--record', record, ...argvFor(['examples/dropdown-handoff'])] });
  assert.equal(run.processes.at(-1)?.outcome?.status, 'complete', run.processes.map((each) => `${each.outcome?.message ?? ''}\n${each.stderr}`).join('\n'));
  assert.match(run.record.answer, /^\(scripted: no model read the task\) The browser opened on a page that reads: /);
  assert.deepEqual(validateRecording(record), []);
  const events = lines(record);
  const input = events.filter((line) => line.kind === 'agentrun.workflow').map((line) => line.data?.value?.input?.input ?? line.data?.input?.input).find(Boolean);
  assert.equal(input?.question, exampleAt('dropdown-handoff').question);
  assert.deepEqual(events.filter((line) => line.kind.startsWith('frame')), [], 'the fake browser has no pictures');
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.example, manifest.kills, manifest.generations], ['dropdown-handoff', 0, 1]);
});
