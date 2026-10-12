// assemble-skills.ts: what the page reads from home/ after the cluster beat. The outputs equal train/assemble_skills.py's as
// JSON (checked on the eight skills of a real run); these tests pin the rules on small policies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_STD, SWITCH, assemble, assembleHome } from '../assemble-skills.ts';
import { Policy, dummyPolicy, f32ToBase64, type PolicyFile } from '../policy.ts';

const SHA = 'a'.repeat(64);
const MJ = '3.3.6';
const pol = (amp: number, sha = SHA): PolicyFile => dummyPolicy({ mjcfSha256: sha, mujocoVersion: MJ, nj: 4, amp });
// A get-up network trained with one input that never varied: its std sits at the floor and must be pinned.
const getupPol = (): PolicyFile => ({ ...pol(0.1), obs: { spec: [{ name: 'phase', size: 2 }], mean: [0, 0], std: [1, 1e-6] } });
const dir = (skill: string, policy: PolicyFile, command = 0.5, status = 'done') => ({ meta: { skill, status, command, label: skill }, policy });

test('every done skill comes home with the get-up network; get-up is the walk at command 0', async () => {
  const walk = pol(0.25), spin = pol(0.3), getup = getupPol();
  const r = await assemble([dir('get-up', getup, 0), dir('spin', spin, 0), dir('walk', walk, 0.5)]);
  assert.ok(!('refused' in r));
  assert.deepEqual(Object.keys(r.manifest.skills).sort(), ['get-up', 'spin', 'walk']);
  assert.equal(r.manifest.default, 'walk');
  assert.equal(r.manifest.body_mjcf_sha256, SHA);
  assert.deepEqual(r.manifest.skills.walk, { policy: 'skills/walk.json', command: 0.5, label: 'walk' });
  assert.equal(r.manifest.skills['get-up']!.command, 0);
  const w = JSON.parse(r.files['skills/walk.json']!);
  assert.deepEqual(w.getup.switch, SWITCH);
  assert.deepEqual(w.getup.obs.std, [1, PINNED_STD]);
  assert.deepEqual(w.getup.layers, getup.layers);
  assert.equal(w.layers[0].w, walk.layers[0]!.w);
  const g = JSON.parse(r.files['skills/get-up.json']!);
  assert.equal(g.layers[0].w, walk.layers[0]!.w, 'the get-up skill stands on the walk network');
  for (const text of Object.values(r.files)) await Policy.load(text, { mjcfSha256: SHA, nj: 4, mujocoVersion: MJ });
});

test('a skill trained for another body, or not done, stays out', async () => {
  const r = await assemble([dir('get-up', getupPol(), 0), dir('walk', pol(0.25)), dir('spin', pol(0.3, 'b'.repeat(64)), 0), dir('wave', pol(0.2), 0, 'training')]);
  assert.ok(!('refused' in r));
  assert.deepEqual(Object.keys(r.manifest.skills).sort(), ['get-up', 'walk']);
  assert.equal(r.leftOut.spin, 'trained for another body');
});

test('a diverged policy stays out and is named', async () => {
  const bad = pol(0.25);
  bad.layers = [{ ...bad.layers[0]!, w: f32ToBase64([NaN, 0, 0, 0, 0, 0, 0, 0]) }];
  const r = await assemble([dir('get-up', getupPol(), 0), dir('walk', pol(0.25)), dir('sprint', bad, 1.2)]);
  assert.ok(!('refused' in r));
  assert.match(r.leftOut.sprint!, /not finite/);
  assert.ok(!('sprint' in r.manifest.skills));
});

test('no get-up network: refused, unless the run asks for the skills without one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assemble-'));
  for (const [name, p, c] of [['walk', pol(0.25), 0.5], ['spin', pol(0.3), 0]] as const) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'skill.json'), JSON.stringify({ skill: name, status: 'done', command: c, label: name }));
    writeFileSync(join(root, 'skills', name, 'policy.json'), JSON.stringify(p));
  }
  assert.equal(await assembleHome(join(root, 'skills'), join(root, 'home')), 2);
  assert.ok(!existsSync(join(root, 'home', 'skills.json')), 'a refusal writes nothing');
  assert.equal(await assembleHome(join(root, 'skills'), join(root, 'home'), { withoutGetup: true }), 0);
  const m = JSON.parse(readFileSync(join(root, 'home', 'skills.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.skills).sort(), ['spin', 'walk']);
  const w = JSON.parse(readFileSync(join(root, 'home', 'skills', 'walk.json'), 'utf8'));
  assert.equal(w.getup, undefined);
});

test('leaves out what the page would refuse, the same skills as the Python twin (shared fixtures)', async () => {
  const fix = fileURLToPath(new URL('./fixtures/assemble/', import.meta.url));
  const expected = JSON.parse(readFileSync(join(fix, 'expected.json'), 'utf8'));
  const home = mkdtempSync(join(tmpdir(), 'assemble-fix-'));
  assert.equal(await assembleHome(join(fix, 'skills'), home), 0);
  const m = JSON.parse(readFileSync(join(home, 'skills.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.skills).sort(), expected.skills);
  for (const name of Object.keys(expected.left_out)) assert.ok(!existsSync(join(home, 'skills', `${name}.json`)), name);
});

test('one damaged skill never stops the rest, with no get-up network to combine with', async () => {
  const fix = fileURLToPath(new URL('./fixtures/assemble/skills/walk/', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'assemble-damaged-'));
  for (const name of ['walk', 'wave']) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    const meta = JSON.parse(readFileSync(join(fix, 'skill.json'), 'utf8'));
    const pol = JSON.parse(readFileSync(join(fix, 'policy.json'), 'utf8'));
    if (name === 'wave') pol.layers[0].w = 'abc'; // not valid base64
    writeFileSync(join(root, 'skills', name, 'skill.json'), JSON.stringify({ ...meta, skill: name }));
    writeFileSync(join(root, 'skills', name, 'policy.json'), JSON.stringify(pol));
  }
  assert.equal(await assembleHome(join(root, 'skills'), join(root, 'home'), { withoutGetup: true }), 0);
  const m = JSON.parse(readFileSync(join(root, 'home', 'skills.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.skills), ['walk']);
});
