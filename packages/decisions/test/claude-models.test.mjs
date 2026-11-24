// The one table of which Claude models take a temperature and an effort, shared by llm-control and the bench (D5).
import assert from 'node:assert/strict';
import test from 'node:test';
import { takesEffort, temperatureFor, temperatureRecord } from '../dist/index.js';

const REFUSE = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-2', 'claude-fable-5', 'claude-mythos-5-2', 'us.anthropic.claude-haiku-5-5-v1:0', 'anthropic/claude-sonnet-5-5'];
const TAKE = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-20241022', 'claude-3-7-sonnet-latest'];

test('temperature 0 goes to a model that takes one; none to Opus 4.7 and later, the Claude 5 family, Fable or Mythos, which refuse it', () => {
  for (const model of REFUSE) assert.equal(temperatureFor(model), undefined, model);
  for (const model of TAKE) assert.equal(temperatureFor(model), 0, model);
});

test('effort goes only to a model that takes it: Opus 4.5 and later, Sonnet 4.6 and later, the Claude 5 family, Fable and Mythos', () => {
  for (const model of [...REFUSE, 'claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6']) assert.equal(takesEffort(model), true, model);
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-20241022']) assert.equal(takesEffort(model), false, model);
});

test('the record: a temperature not sent is not applied; one sent to Anthropic itself is; one sent through anything else may have been dropped', () => {
  assert.deepEqual(temperatureRecord(undefined, true), { temperature_sent: null, temperature_applied: false });
  assert.deepEqual(temperatureRecord(0, true), { temperature_sent: 0, temperature_applied: true });
  assert.deepEqual(temperatureRecord(0, false), { temperature_sent: 0, temperature_applied: 'unknown' });
});
