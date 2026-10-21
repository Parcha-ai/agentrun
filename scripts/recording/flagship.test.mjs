// Draft 55 and its amendments 1 and 2: the flagship's nine documents, checked by the validator on a fakes recording that carries
// all of them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRecording } from './validate.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('a still, not really a png');
const WEBM = Buffer.from('a rollout, not really a webm');
const BODY = Buffer.from('{"legs":4}\n');
const manifest = {
  format: 'agentrun.recording/1', title: 'Teach it to walk (fakes)', task: 'teach-it-to-walk',
  recorded: { started: '2026-10-21T00:00:00.000Z', ended: '2026-10-21T00:00:09.000Z' },
  code: { repo: 'agentrun', commit: 'abc1234', packages: { '@parcha/agentrun-dsl': '0.1.0', '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } },
  model: 'faux/faux-1', generations: 1, kills: 0, cost: { usd: 0, parts: {} }, source: { run: 'run-1', store_sha256: 'a'.repeat(64) },
};
const place = { environment: 'gpu-pool', kind: 'modal', host: 'host-1', box: 'box-1' };
/** The six documents, as the flagship's tools write them, with `over` replacing a document's value (null deletes it). */
const documents = (over = {}) => ({
  'placement': ['pl-1', { work: 'train', ref: { doc: 'train.checkpoints', key: 'ck-1' }, current: 'local', phase: 'message', rest: 'local',
    need: { p: 0.8, threshold: 0.5 }, where: { choice: 'gpu-pool', options: [{ environment: 'gpu-pool', purpose: 'GPU training', p: 0.7 }, { environment: 'local', purpose: 'this machine', p: 0.3 }] },
    chosen: 'gpu-pool', rule: 'transport.need-threshold/1', placer: 'jev', classifier: { provider: 'typesafe', model: 'jev-1' }, at: '2026-10-21T00:00:04.000Z', basis: 'scripted' }],
  'train.checkpoints': ['ck-1', { thread: 51, step: 400, place, bytes: 2048, placer: 'jev', placement: 'pl-1', basis: 'scripted' }],
  'train.progress': ['51', { step: 400, steps_total: 1000, reward: 1.25, unit: 'return/episode', skill: 'walk forward', checkpoint: 'ck-1',
    metric: { name: 'speed', value: 0.42, unit: 'm/s', target: { op: '>=', value: 0.4 } }, passes: true, t_s: 31.5, status: 'running',
    passed_at: { checkpoint: 'ck-1', step: 400, t_s: 31.5 }, diagnosis: 'still-changing', body: 'four legs', basis: 'scripted' }],
  'train.render': ['51', { blob: sha(WEBM), w: 640, h: 360, step: 400, checkpoint: 'ck-1', basis: 'scripted' }],
  'train.sweeps': ['sweep-1', { checkpoint: 'ck-1', rollouts: 16, score: 0.8, unit: 'success rate', place, placer: 'jev', passes_share: 0.75, min: 0.5, max: 0.95, course: 'flat ground', basis: 'scripted' }],
  'body.design': ['b-1a2b3c4d', { blob: sha(BODY), label: 'four legs', language: 'json', basis: 'agent' }],
  'learn.curve': ['quadruped', { x: { label: 'step', unit: 'steps' }, y: { label: 'reward', unit: 'm/s' }, points: [[0, 0.1], [200, null], [400, 1.25]],
    target: { y: 0.4, label: 'walks' }, marks: [{ x: 400, label: 'passes' }], basis: 'scripted' }],
  'body.run': ['b-1a2b3c4d', { kind: 'stand', outcome: 'stood', seconds: 4.2, fits: true, pieces: 9, motors: 8, mass: 2.5, height: 0.31, place, basis: 'scripted' }],
  'body.render': ['b-1a2b3c4d', { blob: sha(PNG), w: 320, h: 240, basis: 'simulated' }],
  ...Object.fromEntries(Object.entries(over).map(([doc, value]) => [doc, [over[`${doc}.key`] ?? null, value]]).filter(([doc]) => !doc.endsWith('.key'))),
});
/** A recording of one process: the run's conversation 51 (an entry), a run.json holder on host-1, a box.receipt for box-1,
 *  then each document at its own commit. */
function recording(t, over = {}, { keys = {}, raw = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flagship-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'blobs'));
  for (const [bytes, ext] of [[PNG, 'png'], [WEBM, 'webm'], [BODY, 'json']]) writeFileSync(join(dir, 'blobs', `${sha(bytes)}.${ext}`), bytes);
  const base = documents();
  const lines = [
    { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 0, data: { gen: 1, pid: 1 } },
    { channel: 'live', source: 'host', kind: 'run.json', t: 1, seq: 1, data: { gen: 1, holder: { driver: 'modal', host: 'host-1' } } },
    { channel: 'live', source: 'host', kind: 'box.receipt', t: 2, seq: 2, data: { box: 'box-1', provider: 'modal' } },
    { channel: 'durable', source: 'pi', kind: 'pi.user', gen: 1, t: 3, commit: 1, order: 0, conv: 51, data: { kind: 'pi.user', id: 1, conversationId: 51, model: [{ role: 'user', content: 'walk' }] } },
  ];
  let commit = 2;
  for (const doc of Object.keys(base)) {
    const value = doc in over ? over[doc] : base[doc][1];
    const key = keys[doc] ?? base[doc][0];
    lines.push({ channel: 'durable', source: 'host', kind: doc, gen: 1, t: 2 + commit, commit, order: 0, data: { doc, key, value, version: 1 } });
    commit += 1;
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  // `raw` replaces text in the file: JSON.stringify cannot write a number such as 1e999, which JSON.parse reads as Infinity.
  writeFileSync(join(dir, 'events.jsonl'), raw.reduce((file, [from, to]) => file.replace(from, to), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`));
  return dir;
}
const problems = (t, over, options) => validateRecording(recording(t, over, options)).map((problem) => problem.message);
const base = documents();
const with_ = (doc, change) => ({ [doc]: { ...base[doc][1], ...change } });

test('draft 55: a fakes recording with all nine documents, basis scripted and one curve gap, is valid', (t) => {
  assert.deepEqual(problems(t), []);
  assert.deepEqual(problems(t, with_('train.progress', { basis: undefined })), [], 'a missing basis reads as unmeasured');
  assert.deepEqual(problems(t, { 'train.render': null }), [], 'a deleted document has nothing to check');
});

test('draft 55: a measured story number needs its unit: a reward, a sweep\'s score and a curve\'s y', (t) => {
  assert.deepEqual(problems(t, with_('train.progress', { basis: 'measured', unit: undefined })), ['train.progress "51": its reward has no unit, and its basis is measured']);
  assert.deepEqual(problems(t, with_('train.sweeps', { basis: 'measured', unit: undefined })), ['train.sweeps "sweep-1": its score has no unit, and its basis is measured']);
  assert.deepEqual(problems(t, with_('learn.curve', { basis: 'measured', y: { label: 'reward' } })), ['learn.curve "quadruped": its y axis has no unit, and its basis is measured']);
  assert.deepEqual(problems(t, with_('learn.curve', { y: { label: 'reward' } })), [], 'not measured: the unit is optional');
});

test('draft 55: a place holds only labels the recording gave, and kinds', (t) => {
  assert.deepEqual(problems(t, with_('train.sweeps', { place: { ...place, box: 'box-7' } })), ['train.sweeps "sweep-1": its place\'s box "box-7" is not a box-N label of a box line in this recording']);
  assert.deepEqual(problems(t, with_('train.sweeps', { place: { ...place, box: 'sb-9f3a2c' } })), ['train.sweeps "sweep-1": its place\'s box "sb-9f3a2c" is not a box-N label of a box line in this recording'], 'a provider\'s id is no label');
  assert.deepEqual(problems(t, with_('train.checkpoints', { place: { ...place, host: 'host-2' } })), ['train.checkpoints "ck-1": its place\'s host "host-2" is not a host-N label of a run.json holder in this recording']);
  assert.deepEqual(problems(t, with_('train.checkpoints', { place: { ...place, kind: 'gcp' } })), ['train.checkpoints "ck-1": its place\'s kind "gcp" is not one of local, daytona, modal, archil, tab']);
  assert.deepEqual(problems(t, with_('train.checkpoints', { place: { ...place, provider: 'modal', sandbox: 'sb-1' } })), [
    'train.checkpoints "ck-1": its place holds provider: a place keeps only environment, kind, host and box, never an id, a path or a machine name',
    'train.checkpoints "ck-1": its place holds sandbox: a place keeps only environment, kind, host and box, never an id, a path or a machine name']);
});

test('draft 55: the basis is one tag per document, of the enum', (t) => {
  assert.deepEqual(problems(t, with_('train.progress', { basis: 'estimated' })), ['train.progress "51": basis "estimated" is not one of measured, scripted, unmeasured, agent, simulated, reported']);
  assert.deepEqual(problems(t, with_('train.progress', { basis: { reward: 'measured' } })), ['train.progress "51": basis {"reward":"measured"} is not one of measured, scripted, unmeasured, agent, simulated, reported'], 'no per-field form');
});

test('draft 55: blobs, conversations and checkpoints are the recording\'s own', (t) => {
  assert.deepEqual(problems(t, with_('train.render', { blob: sha(BODY) })), [`train.render "51": its blob ${sha(BODY)} is a json file, not one of png, jpg, jpeg, webp, gif, webm`]);
  assert.deepEqual(problems(t, with_('body.design', { blob: sha(PNG) })), [`body.design "b-1a2b3c4d": its blob ${sha(PNG)} is a png file, not one of json, txt, md`]);
  assert.deepEqual(problems(t, with_('train.render', { blob: 'b'.repeat(64) })), [`train.render "51": its blob ${'b'.repeat(64)} is not in blobs/`]);
  assert.deepEqual(problems(t, {}, { keys: { 'train.progress': '77' } }), ['train.progress "77": its key "77" names no conversation in this recording']);
  assert.deepEqual(problems(t, with_('train.checkpoints', { thread: 90 })), ['train.checkpoints "ck-1": its thread 90 names no conversation in this recording']);
  assert.deepEqual(problems(t, with_('train.sweeps', { checkpoint: 'ck-9' })), ['train.sweeps "sweep-1": checkpoint "ck-9" names no train.checkpoints key in this recording']);
  assert.deepEqual(problems(t, with_('train.progress', { checkpoint: undefined })), [], 'progress may name no checkpoint');
});

test('draft 55: the shapes: a render\'s size, a curve\'s points, numbers finite, text plain and short', (t) => {
  assert.deepEqual(problems(t, with_('train.render', { w: undefined })), ['train.render "51": its w is not an integer above 0'], 'a video has its size too');
  assert.deepEqual(problems(t, with_('learn.curve', { points: [[0, 1], [2, 'Infinity']] })), ['learn.curve "quadruped": its point 1 has a y that is neither a finite number nor null'], 'a string');
  assert.deepEqual(problems(t, with_('learn.curve', { points: [[0, 1], [2, 7777]] }), { raw: [['[2,7777]', '[2,1e999]']] }), ['learn.curve "quadruped": its point 1 has a y that is neither a finite number nor null'], 'a number JSON reads as Infinity');
  assert.deepEqual(problems(t, with_('learn.curve', { points: [[0, 1], [2, null]] })), [], 'a null y is a gap');
  assert.deepEqual(problems(t, with_('learn.curve', { points: [[5, 1], [2, 2]] })), ['learn.curve "quadruped": its point 1\'s x 2 is below the one before it, 5']);
  assert.deepEqual(problems(t, with_('learn.curve', { points: [[0, 1]] })), ['learn.curve "quadruped": its points are not 2 to 2,000 pairs']);
  assert.deepEqual(problems(t, {}, { keys: { 'learn.curve': 'c'.repeat(65) } }), [`learn.curve "${'c'.repeat(65)}": its key is not plain text of at most 64 characters`]);
  assert.deepEqual(problems(t, with_('train.progress', { reward: Number.NaN })), ['train.progress "51": its reward is not a finite number']);
  assert.deepEqual(problems(t, with_('train.progress', { skill: 'walk\u0007' })), ['train.progress "51": its skill is not plain text of at most 60 characters']);
  assert.deepEqual(problems(t, with_('train.sweeps', { rollouts: 0, placer: 'gpt' })), ['train.sweeps "sweep-1": its rollouts is not an integer above 0', 'train.sweeps "sweep-1": its placer "gpt" is not one of jev, config']);
  assert.deepEqual(problems(t, with_('train.progress', { steps_total: 10 })), ['train.progress "51": its steps_total is not an integer of at least its step']);
});

test('amendment 1: a metric and its target say whether it passes; the new fields and the two body documents', (t) => {
  const progress = base['train.progress'][1];
  assert.deepEqual(problems(t, with_('train.progress', { passes: false })), ['train.progress "51": its passes is false, but its metric 0.42 >= 0.4 is true']);
  assert.deepEqual(problems(t, with_('train.progress', { metric: { ...progress.metric, target: { op: '<', value: 0.4 } } })), ['train.progress "51": its passes is true, but its metric 0.42 < 0.4 is false']);
  assert.deepEqual(problems(t, with_('train.progress', { metric: { ...progress.metric, target: '>= 0.4' } })), ['train.progress "51": its metric\'s target is not { op (>=, <=, >, <), value (a finite number) }'], 'never free text');
  assert.deepEqual(problems(t, with_('train.progress', { basis: 'measured', metric: { name: 'speed', value: 0.42 }, passes: undefined })), ['train.progress "51": its metric has no unit, and its basis is measured']);
  assert.deepEqual(problems(t, with_('train.progress', { basis: 'measured', reward: undefined, unit: undefined })), [], 'an absent reward is absent; the rest stays measured');
  assert.deepEqual(problems(t, with_('train.progress', { status: 'paused', diagnosis: 'slow' })), ['train.progress "51": its status "paused" is not one of running, done, failed, refused', 'train.progress "51": its diagnosis "slow" is not one of never-moved, plateaued, never-settles, never-measured, still-changing, test-raised']);
  assert.deepEqual(problems(t, with_('train.progress', { passed_at: { checkpoint: 'ck-9', step: 400, t_s: 31.5 } })), ['train.progress "51": checkpoint "ck-9" names no train.checkpoints key in this recording']);
  assert.deepEqual(problems(t, with_('train.checkpoints', { passes: false, metric: { name: 'speed', value: 0.5, target: { op: '>=', value: 0.4 } } })), ['train.checkpoints "ck-1": its passes is false, but its metric 0.5 >= 0.4 is true']);
  assert.deepEqual(problems(t, with_('train.sweeps', { passes_share: 1.5, min: 0.9, max: 0.1 })), ['train.sweeps "sweep-1": its passes_share is not a number from 0 to 1', 'train.sweeps "sweep-1": its min 0.9 is above its max 0.1']);
  assert.deepEqual(problems(t, with_('learn.curve', { target: { y: 'fast' }, marks: [{ x: 'a' }] })), ['learn.curve "quadruped": its target y is not a finite number', 'learn.curve "quadruped": its target label is not plain text of at most 40 characters', 'learn.curve "quadruped": its mark 0 is not { x (a finite number), label (plain text of at most 40 characters) }']);
  assert.deepEqual(problems(t, with_('body.run', { kind: 'walk', fits: 'yes', place: { ...place, box: 'box-3' } })), ['body.run "b-1a2b3c4d": its kind "walk" is not one of build, stand, skill', 'body.run "b-1a2b3c4d": its fits is not true or false', 'body.run "b-1a2b3c4d": its place\'s box "box-3" is not a box-N label of a box line in this recording']);
  assert.deepEqual(problems(t, with_('body.render', { blob: sha(BODY) })), [`body.render "b-1a2b3c4d": its blob ${sha(BODY)} is a json file, not one of png, webp, webm`]);
  assert.deepEqual(problems(t, {}, { keys: { 'body.design': 'quadruped' } }), ['body.design "quadruped": its key is not a body id, b- and 8 hex digits']);
});

test('amendment 1: a body render is a clip of at most 600 KB', (t) => {
  const big = Buffer.alloc(600_001, 1);
  const dir = recording(t, with_('body.render', { blob: sha(big) }));
  writeFileSync(join(dir, 'blobs', `${sha(big)}.webm`), big);
  assert.deepEqual(validateRecording(dir).map((problem) => problem.message), [`body.render "b-1a2b3c4d": its blob is 600001 bytes, over the 600000 a body render may be`]);
});

test('amendment 2: a placement follows its named rule from its own inputs, an error first, never the most likely option', (t) => {
  const pl = base.placement[1];
  const rule = (change) => problems(t, with_('placement', change));
  const wrong = (got, want) => [`placement "pl-1": its chosen "${got}" is not what transport.need-threshold/1 gives, "${want}"`];
  // Move: the need clears its threshold and the choice is elsewhere.
  assert.deepEqual(rule({ chosen: 'local' }), wrong('local', 'gpu-pool'));
  // Stay: the need is below its threshold in a message.
  assert.deepEqual(rule({ need: { p: 0.3, threshold: 0.5 } }), wrong('gpu-pool', 'local'));
  assert.deepEqual(rule({ need: { p: 0.3, threshold: 0.5 }, chosen: 'local' }), []);
  // Back to rest at turn_end, away from rest, below the threshold.
  const away = { current: 'gpu-pool', phase: 'turn_end', need: { p: 0.3, threshold: 0.5 } };
  assert.deepEqual(rule({ ...away, chosen: 'local' }), []);
  assert.deepEqual(rule({ ...away, chosen: 'gpu-pool' }), wrong('gpu-pool', 'local'));
  // FIRST, an error or an absent need: it stays, even with a high need toward elsewhere, even at turn_end away from rest.
  assert.deepEqual(rule({ error: 'invalid_answer', chosen: 'local' }), []);
  assert.deepEqual(rule({ error: 'invalid_answer' }), wrong('gpu-pool', 'local'));
  assert.deepEqual(rule({ ...away, error: 'aborted', chosen: 'gpu-pool' }), [], 'an error at turn_end away from rest stays');
  assert.deepEqual(rule({ need: undefined, chosen: 'local' }), [], 'no need: it stays');
  // Never the most likely option: the classifier's choice stands though it is less likely.
  assert.deepEqual(rule({ where: { choice: 'gpu-pool', options: [{ environment: 'gpu-pool', p: 0.4 }, { environment: 'local', p: 0.6 }] } }), []);
  // config goes to rest, which it must name; a plain Jev placement takes its one choice; an unknown rule is unchecked.
  assert.deepEqual(rule({ placer: 'config', rule: undefined, chosen: 'local' }), []);
  assert.deepEqual(rule({ placer: 'config', rule: undefined, chosen: 'gpu-pool' }), ['placement "pl-1": its chosen "gpu-pool" is not what a config placement gives, "local"']);
  assert.deepEqual(rule({ placer: 'config', rule: undefined, rest: undefined, chosen: 'local' }), ['placement "pl-1": its rest is required for a config placement'], 'with no rest there is nothing to check chosen against');
  // Rule first: a named rule decides, placer config included, so an errored turn_end under the rule stays at current.
  assert.deepEqual(rule({ placer: 'config', ...away, error: 'aborted', chosen: 'gpu-pool' }), [], 'config under the rule: the rule decides');
  assert.deepEqual(rule({ placer: 'config', ...away, error: 'aborted', chosen: 'local' }), wrong('local', 'gpu-pool'), 'not config\'s rest');
  assert.deepEqual(rule({ placer: 'config', rule: 'transport.other/2', chosen: 'gpu-pool' }), [], 'config under an unknown rule: unchecked');
  assert.deepEqual(rule({ rest: undefined }), ['placement "pl-1": its rest is required under transport.need-threshold/1']);
  assert.deepEqual(rule({ rule: undefined, need: undefined, chosen: 'local' }), ['placement "pl-1": its chosen "local" is not what its one choice question gives, "gpu-pool"']);
  assert.deepEqual(rule({ rule: 'transport.other/2', chosen: 'local' }), [], 'an unknown rule is left unchecked');
  // The shapes: probabilities, a distribution, choices among the options, no request hash under transport, the tie.
  assert.deepEqual(rule({ need: { p: 1.2, threshold: 0.5 } }), ['placement "pl-1": its need p is not a number from 0 to 1', ...wrong('gpu-pool', 'local')]);
  assert.deepEqual(rule({ where: { ...pl.where, options: [{ environment: 'gpu-pool', p: 0.7 }, { environment: 'local', p: 0.5 }] } }), ['placement "pl-1": its options\' p sum to 1.2, not 1 within 0.02']);
  assert.deepEqual(rule({ where: { ...pl.where, choice: 'tpu-pool' } }), ['placement "pl-1": its where choice "tpu-pool" is not one of its options', ...wrong('gpu-pool', 'tpu-pool')]);
  assert.deepEqual(rule({ request: 'a'.repeat(64) }), ['placement "pl-1": its request is set, but a transport.need-threshold/1 placement has no request hash']);
  assert.deepEqual(rule({ classifier: { provider: 'typesafe' } }), ['placement "pl-1": its classifier is not { provider, model }']);
  assert.deepEqual(rule({ ref: { doc: 'train.checkpoints', key: 'ck-9' } }), ['placement "pl-1": its ref {"doc":"train.checkpoints","key":"ck-9"} names nothing in this recording']);
  assert.deepEqual(rule({ phase: 'soon' }), ['placement "pl-1": its phase "soon" is not one of message, turn_end']);
  assert.deepEqual(problems(t, with_('train.checkpoints', { placement: 'pl-9' })), ['train.checkpoints "ck-1": its placement "pl-9" names no placement in this recording']);
});
