import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRunReport } from '../dist/presentation.js';

const report = { digest: 'test', status: 'complete', calls: { agent: 0, judge: 0, tool: 1 }, events: [] };

test('human-readable output retains values and limits display without changing the report', () => {
  const original = { ...report, output: { findings: [{ sourceId: 'record-1', text: 'Supported by the source.' }], raw: 'x'.repeat(15_000) } };
  const retained = structuredClone(original);
  const displayed = formatRunReport(original);
  assert.match(displayed, /source id: record-1/);
  assert.match(displayed, /Supported by the source/);
  assert.match(displayed, /Full output is in the structured result/);
  assert.deepEqual(original, retained);
  assert.ok(displayed.length < 13_000);
});

test('camelCase output keys are readable sentence-case labels', () => {
  const displayed = formatRunReport({ ...report, output: { nextAction: 'Review the change.', uncertaintyNote: 'Cause unknown.' } });
  assert.match(displayed, /next action: Review the change/);
  assert.match(displayed, /uncertainty note: Cause unknown/);
});

test('failed and uncertain effects show recovery without encouraging blind retries', () => {
  const displayed = formatRunReport({ ...report, status: 'failed', error: { code: 'execution_failed', message: 'Workflow failed.' }, uncertainEffects: [{ idempotencyKey: 'effect-1', outcome: 'unknown' }] });
  assert.match(displayed, /execution_failed/);
  assert.match(displayed, /\/agentrun status/);
  assert.match(displayed, /Check their actual state before retrying/);
});

test('terminal control characters are removed from untrusted output', () => {
  const displayed = formatRunReport({ ...report, output: '\u001b[2J\u202ehello' });
  assert.doesNotMatch(displayed, /[\u001b\u202e]/);
  assert.match(displayed, /hello/);
});

test('object field truncation is disclosed', () => {
  const output = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`field${index}`, index]));
  assert.match(formatRunReport({ ...report, output }), /1 more fields in the structured result/);
});


test('escalation is explained without changing its machine status or hiding the stop reason', () => {
  const stopped = { ...report, status: 'escalated', escalation: { summary: 'No sources met the evidence threshold.' } };
  const before = structuredClone(stopped);
  const displayed = formatRunReport(stopped, true);
  assert.match(displayed, /stopped — needs attention \(escalated\)/);
  assert.match(displayed, /No sources met the evidence threshold/);
  assert.match(displayed, /no model calls/);
  assert.deepEqual(stopped, before);
});

test('scripted replay keeps its mode without suggesting a switch to a different example', () => {
  const displayed = formatRunReport(report, true);
  assert.match(displayed, /Replay: \/agentrun run/);
  assert.match(displayed, /Example modes: \/agentrun help/);
  assert.doesNotMatch(displayed, /\/agentrun demo live/);
});

test('bounded trace retention is disclosed separately from output completeness', () => {
  const displayed = formatRunReport({ ...report, output: { value: 7 }, traceTruncated: true,
    trace: { policy: 'tail', receivedEvents: 20, receivedBytes: 2000, retainedEvents: 4, retainedBytes: 400,
      droppedEvents: 16, droppedBytes: 1600, rejectedEvents: 0 } });
  assert.match(displayed, /Workflow: complete/);
  assert.match(displayed, /value: 7/);
  assert.match(displayed, /16 valid events omitted, 0 rejected/);
  assert.match(displayed, /does not mean the output is truncated/);
});
