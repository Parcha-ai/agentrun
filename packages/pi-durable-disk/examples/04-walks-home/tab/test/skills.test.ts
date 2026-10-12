import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkills, skillPolicyPath, SkillsRefused } from '../src/skills.ts';

const SHA = 'a'.repeat(64);
const ok = { version: 1, body_mjcf_sha256: SHA, default: 'walk', skills: { walk: { policy: 'skills/walk.json', command: 0.5, label: 'walk' }, sprint: { policy: 'skills/sprint.json', command: 1.2, label: 'sprint' }, backwards: { policy: 'skills/backwards.json', command: -0.4, label: 'walk backwards' }, 'turn-left': { policy: 'skills/turn-left.json', command: 0, label: 'turn left' } } };

test('a skills manifest names each skill, its policy file, its fixed command (negative for backwards, never clamped at 0) and its label', () => {
  const m = parseSkills(JSON.stringify(ok));
  assert.deepEqual(Object.keys(m.skills), ['walk', 'sprint', 'backwards', 'turn-left']);
  assert.equal(m.skills.backwards!.command, -0.4);
  assert.equal(m.skills.sprint!.command, 1.2);
  assert.equal(m.default, 'walk');
  assert.equal(skillPolicyPath(m.skills.sprint!), 'home/skills/sprint.json');
});

test('a default that is not a skill falls to the first; a missing label is the name', () => {
  const m = parseSkills(JSON.stringify({ ...ok, default: 'fly', skills: { sprint: { policy: 'skills/sprint.json', command: 1 } } }));
  assert.equal(m.default, 'sprint');
  assert.equal(m.skills.sprint!.label, 'sprint');
});

test('what is not a manifest is refused, with the field named', () => {
  for (const [bad, why] of [
    ['not json', /not JSON/],
    [JSON.stringify({ ...ok, version: 2 }), /version must be 1/],
    [JSON.stringify({ ...ok, body_mjcf_sha256: 'x' }), /sha256/],
    [JSON.stringify({ ...ok, skills: {} }), /1 to 16/],
    [JSON.stringify({ ...ok, skills: { 'Bad Name': { policy: 'skills/a.json', command: 0 } } }), /not a skill name/],
    [JSON.stringify({ ...ok, skills: { walk: { policy: '../secret.json', command: 0 } } }), /policy must be skills/],
    [JSON.stringify({ ...ok, skills: { walk: { policy: 'skills/a/b.json', command: 0 } } }), /policy must be skills/],
    [JSON.stringify({ ...ok, skills: { walk: { policy: 'skills/walk.json', command: 9 } } }), /command must be/],
    [JSON.stringify({ ...ok, skills: { walk: { policy: 'skills/walk.json', command: 'fast' } } }), /command must be/],
  ] as const) assert.throws(() => parseSkills(bad), (e: Error) => e instanceof SkillsRefused && why.test(e.message), bad.slice(0, 60));
});
