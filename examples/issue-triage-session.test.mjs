// The live session's parts, offline: what the person says, and that the tools the agent is told about are the tools the workflow calls and the live code provides.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { githubTools } from './issue-triage/github.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { agreementOf, ranWorkflow, resultOf, rowsOf, sentenceFor, session, spentOf, TOOLS } from './issue-triage/session.ts';

const workflow = JSON.parse(readFileSync(new URL('./issue-triage/workflow.json', import.meta.url), 'utf8'));
const callTools = (node, found = new Set()) => {
  if (Array.isArray(node)) node.forEach((each) => callTools(each, found));
  else if (node && typeof node === 'object') { if (node.node === 'call' && node.via === 'tool') found.add(node.tool); Object.values(node).forEach((each) => callTools(each, found)); }
  return found;
};

test('the sentence names the issues, the commit the code is read at, and no kill', () => {
  const sentence = sentenceFor({ repo: 'o/r', sha: 'a'.repeat(40), numbers: [3, 5], label_map: { enhancement: 'feature', bug: 'bug' } });
  assert.match(sentence, /o\/r issues #3, #5/);
  assert.match(sentence, new RegExp(`commit ${'a'.repeat(40)}`));
  assert.doesNotMatch(sentence, /kill|restart/i);
});

test('every tool the workflow calls is told to the agent and provided by the live GitHub tools', () => {
  const told = new Set(TOOLS.map((tool) => tool.name));
  const provided = new Set(Object.keys(githubTools({})));
  for (const name of callTools(workflow)) { assert.ok(told.has(name), `${name} is described to the agent`); assert.ok(provided.has(name), `${name} is provided live`); }
  assert.deepEqual(TOOLS.find((tool) => tool.name === 'github_code').parameters.required, ['repo', 'number', 'sha']);
});

test('the research node reads and nothing else: its declared tools are the read tool alone', () => {
  const agents = [];
  (function walk(node) { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { if (node.node === 'agent') agents.push(node); Object.values(node).forEach(walk); } })(workflow);
  assert.ok(agents.length >= 1);
  for (const agent of agents) assert.deepEqual(agent.tools, ['read']);
});

test('the job blob\'s workflow is what an inspect or a load ANSWERED, paired by call id: a refused inspect and a run are ignored, a repaired draft and a loaded one are used', () => {
  const call = (id, action, args = {}) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'agentrun', arguments: { action, ...args } }] });
  const result = (id, body, isError = false) => ({ role: 'toolResult', toolName: 'agentrun', toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify(body) }] });
  const sent = { name: 'sent' }, repaired = { name: 'repaired' }, loaded = { name: 'loaded' };
  assert.equal(ranWorkflow([]), undefined);
  // The model sent `sent`; the tool answered with the repaired draft: the repaired one is the graph.
  const first = [call('1', 'inspect', { workflow: sent }), result('1', { preview: 'p', workflow: repaired, input: { n: 1 } })];
  assert.deepEqual(ranWorkflow(first), { workflow: repaired, input: { n: 1 } });
  // A refused inspect (an error result) changes nothing, and a run result is not a draft.
  const refused = [...first, call('2', 'inspect', { workflow: sent }), result('2', { message: 'no' }, true), call('3', 'run'), result('3', { outcome: { status: 'complete' }, workflow: sent })];
  assert.deepEqual(ranWorkflow(refused), { workflow: repaired, input: { n: 1 } });
  // A draft loaded by name has no workflow in its call at all, and its result is the graph.
  assert.deepEqual(ranWorkflow([...first, call('2', 'inspect', { workflow: sent }), result('2', { message: 'no' }, true), call('4', 'load', { name: 'saved' }), result('4', { preview: 'p', workflow: loaded, saved: { name: 'saved' } })]), { workflow: loaded, input: {} });
  // A draft inspected or loaded AFTER the last run call never ran: the graph stays the one held when the run was called.
  const after = [...refused, call('5', 'inspect', { workflow: sent }), result('5', { preview: 'p', workflow: loaded, input: { n: 2 } }), call('6', 'load', { name: 'other' }), result('6', { preview: 'p', workflow: loaded })];
  assert.deepEqual(ranWorkflow(after), { workflow: repaired, input: { n: 1 } });
  // With no run call at all, the last good one.
  assert.deepEqual(ranWorkflow([...first, call('7', 'inspect'), result('7', { preview: 'p', workflow: loaded, input: {} })]), { workflow: loaded, input: {} });
});

test('demo.json names no Jev cap (the harness refuses models.judge.caps) and the lead default is gemini-3.8-flash', () => {
  const spec = JSON.parse(readFileSync(new URL('./issue-triage/demo.json', import.meta.url), 'utf8'));
  assert.equal(spec.models.judge.caps, undefined);
  assert.equal(spec.models.lead.default, 'google/gemini-3.8-flash');
});

test('the host counts the agreement from the rows: the first maintainer label that is a type, rows with none left out and said so, the agent\'s own count ignored', () => {
  const map = { bug: 'bug', enhancement: 'feature', question: 'question' };
  const rows = [
    { type: 'bug', labels: ['bug'] }, { type: 'bug', labels: ['enhancement'] }, { type: 'feature', labels: ['help wanted', 'enhancement'] },
    { type: 'question', labels: ['awaiting more info'] }, { type: 'docs' },
  ];
  assert.deepEqual(agreementOf(rows, map), { matched: 2, compared: 3, total: 5, summary: "The type matched the maintainers' label on 2 of 3 issues (2 carried no type label)" });
  assert.equal(agreementOf([{ type: 'bug', labels: ['bug'] }], map).summary, "The type matched the maintainers' label on 1 of 1 issues");
  assert.equal(agreementOf(undefined, map), null);
  assert.equal(agreementOf([], map).compared, 0);
});

test('the sentence asks for the rows and says the host counts the matches, never asking the agent for the count', () => {
  const sentence = sentenceFor({ repo: 'o/r', sha: 'a'.repeat(40), numbers: [1], label_map: { bug: 'bug' } });
  assert.match(sentence, /one row per issue/);
  assert.match(sentence, /I count how often the type matches them myself/);
  assert.doesNotMatch(sentence, /tell me how often/);
});

test('spentOf sums the priced parts of the recording lines and an unknown price does not switch it off', () => {
  const assistant = (total) => ({ channel: 'durable', source: 'pi', kind: 'pi.assistant', commit: 1, data: { model: [{ role: 'assistant', usage: { cost: { total } } }] } });
  assert.equal(spentOf([]), 0);
  assert.ok(Math.abs(spentOf([assistant(0.25), { ...assistant(0.5), commit: 2 }]) - 0.75) < 1e-12);
});

test('--max-usd stops the session cleanly: no lead request starts once the known spend has reached the cap, so the spend ends within one call of it', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-cap-'));
  const lines = [];
  const log = console.log; console.log = (line) => lines.push(String(line));
  try {
    // A stubbed lead that calls the agentrun tool forever and answers at once. pi-ai's faux prices nothing, so each call writes the usage a real model reports into the recording's spool, as the recorder writes it: the bill is tied to the call, never to a clock.
    const CALL_USD = 0.0004, CAP_USD = 0.0009;
    const spool = join(dir, 'run', 'meter', '.spool');
    let commit = 0;
    const bill = () => {
      if (!existsSync(spool)) return;
      const line = { channel: 'durable', source: 'pi', kind: 'pi.assistant', commit: ++commit, conv: 1, data: { model: [{ role: 'assistant', usage: { cost: { total: CALL_USD } } }] } };
      appendFileSync(join(spool, 'stub-usage.jsonl'), `${JSON.stringify(line)}\n`);
    };
    const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
    faux.setResponses(Array.from({ length: 400 }, () => () => { bill(); return fauxAssistantMessage([fauxToolCall('agentrun', { action: 'describe' })], { stopReason: 'toolUse' }); }));
    const catalog = createModels(); catalog.setProvider(faux.provider);
    const parts = { host: { models: { catalog, lead: { provider: faux.provider.id, modelId: 'faux-1' } }, decisions: { runJudge: async () => { throw new Error('no judge here'); } } }, tools: {}, models: {} };
    await session({ dir: join(dir, 'run'), input: { repo: 'o/r', sha: 'a'.repeat(40), numbers: [1] }, plain: true, maxUsd: CAP_USD, parts });
    const summary = JSON.parse(lines.at(-1));
    assert.ok(summary.spentUsd >= CAP_USD && summary.spentUsd <= CAP_USD + CALL_USD, `the stop came within one call of the cap: ${summary.spentUsd} (the cap ${CAP_USD}, a call ${CALL_USD}), after ${faux.state.callCount} lead calls`);
    assert.ok(lines.some((line) => /stopped: the known spend, \$[\d.]+, reached --max-usd \$0\.0009/.test(line)), lines.join('\n'));
    assert.equal(summary.outcome, 'over_budget');
    assert.ok(faux.state.callCount <= Math.ceil(CAP_USD / CALL_USD), `no lead request starts once the known spend is at the cap: ${faux.state.callCount} calls`);
    const asked = faux.state.callCount;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(faux.state.callCount, asked, 'the model is not asked again after the stop');
  } finally { console.log = log; process.exitCode = 0; await rm(dir, { recursive: true, force: true }); }
});

test('the rows are the result itself when it is a list, else its rows (the agent chooses the output shape)', () => {
  const rows = [{ type: 'bug', labels: ['bug'] }];
  assert.equal(rowsOf(rows), rows);
  assert.equal(rowsOf({ rows, other: 1 }), rows);
  assert.equal(rowsOf({ nothing: 1 }), null);
  assert.equal(rowsOf(null), null);
  assert.equal(agreementOf(rowsOf(rows), { bug: 'bug' }).matched, 1);
});

test('the recording keeps the rows and the host\'s agreement for a result that is a list and for one that holds rows, never numbered keys', () => {
  const rows = [{ type: 'bug', labels: ['bug'] }, { type: 'docs', labels: ['bug'] }];
  const agreement = agreementOf(rows, { bug: 'bug' });
  assert.deepEqual(resultOf(rows, agreement), { rows, agreement });
  assert.deepEqual(resultOf({ rows, note: 'n', agreement: { matched: 99 } }, agreement), { rows, note: 'n', agreement });
  assert.deepEqual(Object.keys(resultOf(rows, agreement)), ['rows', 'agreement']);
  assert.equal(resultOf(null, null), null);
  assert.deepEqual(resultOf('text', null), { result: 'text', agreement: null });
});

test('a recorded run reads its spend before the recording is finished: the summary carries a nonzero spend and the manifest is written', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-rec-'));
  const lines = [];
  const log = console.log; console.log = (line) => lines.push(String(line));
  try {
    const faux = fauxProvider({ models: [{ id: 'faux-1' }], tokensPerSecond: 20, tokenSize: { min: 1, max: 2 } });
    faux.setResponses(Array.from({ length: 400 }, () => fauxAssistantMessage([fauxToolCall('agentrun', { action: 'describe' })], { stopReason: 'toolUse' })));
    const catalog = createModels(); catalog.setProvider(faux.provider);
    const parts = { host: { models: { catalog, lead: { provider: faux.provider.id, modelId: 'faux-1' } }, decisions: { runJudge: async () => { throw new Error('no judge here'); } } }, tools: {}, models: {} };
    const recording = join(dir, 'recording');
    const spool = join(recording, '.spool');
    let commit = 0;
    const bill = setInterval(() => {
      if (!existsSync(spool)) return;
      appendFileSync(join(spool, 'stub-usage.jsonl'), `${JSON.stringify({ channel: 'durable', source: 'pi', kind: 'pi.assistant', commit: ++commit, conv: 1, data: { model: [{ role: 'assistant', usage: { cost: { total: 0.0004 } } }] } })}\n`);
    }, 300);
    await session({ dir: join(dir, 'run'), input: { repo: 'o/r', sha: 'a'.repeat(40), numbers: [1], label_map: {} }, plain: true, maxUsd: 0.0009, record: recording, parts }).finally(() => clearInterval(bill));
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.outcome, 'over_budget');
    assert.ok(summary.spentUsd > 0, `the spend is read before the spool goes: ${summary.spentUsd}`);
    assert.equal(summary.recording, recording);
    assert.ok(existsSync(join(recording, 'manifest.json')) && !existsSync(spool), 'the recording is finished and its spool is gone');
  } finally { console.log = log; process.exitCode = 0; await rm(dir, { recursive: true, force: true }); }
});
