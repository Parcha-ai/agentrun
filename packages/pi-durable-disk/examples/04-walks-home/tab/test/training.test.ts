import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrainingState } from '../src/training.ts';

const facts = { steps: 2e6, wallS: 40, reportedWalk10sM: 2.1, checkpoint: null };

test('a late checkpoint is refused once the final policy is installed, and the final still takes a checkpoint\'s place', () => {
  const t = new TrainingState();
  assert.equal(t.acceptCheckpoint(), true);
  t.install('checkpoint', facts);
  assert.deepEqual([t.state, t.checkpointN, t.final], ['learning', 1, false]);
  t.install('final', { ...facts, steps: 1e7 });
  assert.deepEqual([t.state, t.final], ['trained', true]);
  assert.equal(t.acceptCheckpoint(), false, 'the training file stays on the disk after the run is home; it must not win');
  assert.equal(t.state, 'trained');
});

test('the trainer\'s own checkpoint number is used when the file has one, otherwise installs are counted', () => {
  const t = new TrainingState();
  t.install('checkpoint', { ...facts, checkpoint: 7 });
  assert.equal(t.checkpointN, 7);
  t.install('checkpoint', facts);
  assert.equal(t.checkpointN, 8, 'a file without a number counts on from the last');
});

test('removing the policy clears every fact and the final flag, so nothing describes a policy that is gone', () => {
  const t = new TrainingState();
  t.install('checkpoint', facts);
  t.install('final', facts);
  t.clear('untrained');
  assert.deepEqual([t.state, t.final, t.checkpointN, t.steps, t.wallS, t.reportedWalkM], ['untrained', false, 0, null, null, null]);
  assert.equal(t.acceptCheckpoint(), true, 'a new body can learn again');
  t.install('checkpoint', facts);
  t.clear('dummy');
  assert.deepEqual([t.state, t.checkpointN, t.steps], ['dummy', 0, null]);
});

test('the label says what the creature has: untrained, learning with the number, trained, or the stand-in\'s name', () => {
  const t = new TrainingState();
  assert.equal(t.label('untrained'), 'untrained: random moves');
  t.install('checkpoint', facts);
  assert.equal(t.label('x'), 'learning: version 1');
  t.install('final', facts);
  assert.equal(t.label('x'), 'trained');
  t.clear('dummy');
  assert.equal(t.label('stand only'), 'stand only (not trained)');
});
