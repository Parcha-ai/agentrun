// One node status for every panel, from durable state (node-status.ts): a recording of a run killed once and resumed,
// whose map body is one node, ends with every item done, in the shared fold and in the workflow map that reads it, and
// so does the same recording with no live workflow event at all; live events say only what is running now.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, type Json, type Line } from '../src/format.ts';
import { nodeStatuses, nodeStatusInit, nodeStatusReduce, pathStatus } from '../src/node-status.ts';
import { workflowMapPanel, wmGlyphOf } from '../src/workflow-map.ts';
import { planOf } from '../src/audit-read.ts';
import { reduceTo } from '../src/replay.ts';

const fixture = new URL('fixtures/disk-resumed/', import.meta.url);
const lines = parseLines(readFileSync(new URL('events.jsonl', fixture), 'utf8'));
const MAP = '/root/steps/0';
const items = Array.from({ length: 10 }, (_, index) => `${MAP}/items/${index}`);
const fold = (upTo: number) => lines.slice(0, upTo).reduce(nodeStatusReduce, nodeStatusInit());

test('the recording: a run killed once and resumed, whose map body is one node, so the plan names no step and no judge answers', () => {
  assert.equal(lines.filter((line) => line.source === 'host' && line.kind === 'kill').length, 1);
  const plans = lines.map(planOf).filter((plan) => plan !== undefined);
  assert.ok(plans.length > 0 && plans.every((plan) => plan!.steps.length === 0), 'a body of one call: no steps for a "last step" rule to find');
  assert.equal(lines.some((line) => line.kind === 'judge.answered' || line.kind === 'verify.answered'), false, 'no verdict for a judge rule to find');
});

test('at the end every map item is done, from the driver\'s checkpoint', () => {
  const end = fold(lines.length);
  for (const item of items) assert.equal(pathStatus(end, `${item}/body`), 'done', item);
  assert.deepEqual(nodeStatuses(end).get(`${MAP}/body`), { done: 10, running: 0, failed: 0 });
  assert.equal(pathStatus(end, MAP), 'done', 'and the map itself');
});

test('the workflow map, reading that one fold, shows every item done at the end', () => {
  const state = reduceTo(workflowMapPanel, lines, lines.length);
  const glyphs = items.map((item) => (state.branches[item] ? wmGlyphOf(state, state.branches[item]!) : 'missing'));
  assert.deepEqual(glyphs, items.map(() => 'done'));
});

test('with no live workflow event at all (a process that finishes items from its journal writes none), every item is still done', () => {
  const durableOnly = lines.filter((line) => line.channel === 'durable' || line.source === 'host');
  const end = durableOnly.reduce(nodeStatusReduce, nodeStatusInit());
  for (const item of items) assert.equal(pathStatus(end, `${item}/body`), 'done', item);
  const state = reduceTo(workflowMapPanel, durableOnly, durableOnly.length);
  assert.deepEqual(items.map((item) => (state.branches[item] ? wmGlyphOf(state, state.branches[item]!) : 'missing')), items.map(() => 'done'));
});

test('live events say only what runs now: a started node runs until it ends, and a kill ends what its process ran', () => {
  const kill = lines.findIndex((line) => line.source === 'host' && line.kind === 'kill');
  const before = fold(kill);
  assert.ok(before.started.length > 0, 'something was running when the kill came');
  assert.deepEqual(fold(kill + 1).started, [], 'the kill ends it');
  for (const path of before.started) assert.notEqual(pathStatus(fold(kill + 1), path), 'running', path);
});

test('a step the checkpoint keeps as failed is failed, and an item record\'s own failed step too', () => {
  const driver = (commit: number, pin: Json): Line => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: commit, commit, order: 0, data: { doc: 'agentrun.driver', value: { state: { schema: 'agentrun.frozen_run.v3', pin } } } });
  const item = (commit: number, steps: Json): Line => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.items', gen: 1, t: commit, commit, order: 1, data: { doc: 'agentrun.items', key: `run\u0000${MAP}/items/0`, value: { status: 'running', frame: { done: [], steps } } } });
  const state = [driver(1, { done: ['/root/steps/1'], steps: { '/root/steps/2': { label: 'post', attempt: 2, attemptsAllowed: 2, status: 'failed' } } }), item(2, { [`${MAP}/items/0/body/steps/1`]: { label: 'read', attempt: 0, attemptsAllowed: 1, status: 'failed' } })]
    .reduce(nodeStatusReduce, nodeStatusInit());
  assert.equal(pathStatus(state, '/root/steps/2'), 'failed');
  assert.equal(pathStatus(state, `${MAP}/items/0/body/steps/1`), 'failed');
  assert.equal(pathStatus(state, '/root/steps/1'), 'done');
  assert.equal(pathStatus(state, '/root/steps/3'), 'pending');
});

test('a scrub to any point equals a fresh reduce to it', () => {
  let state = workflowMapPanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    if (p % 20 === 0 || p === lines.length) assert.deepEqual(state, reduceTo(workflowMapPanel, lines, p), `at ${p}`);
    if (p < lines.length && workflowMapPanel.accepts(lines[p]!)) state = workflowMapPanel.reduce(state, lines[p]!);
  }
});
