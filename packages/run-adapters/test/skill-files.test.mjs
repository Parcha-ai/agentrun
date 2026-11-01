// read_skill_file (skill-files.ts): the model reads a skill's own listed files, exactly, and nothing else of the disk.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { READ_SKILL_FILE, readSkillFileTool } from '@parcha/agentrun-adapters';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-skill-files-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A skills root with two skills, each with its files, and a secret beside the root. */
function skills() {
  const base = mkdtempSync(join(ROOT, 's-'));
  const root = join(base, 'skills');
  const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
  write(join(root, 'research', 'SKILL.md'), '---\nname: research\n---\nRead reference/sources.md.\n');
  write(join(root, 'research', 'reference', 'sources.md'), 'Primary sources first. ✓\n');
  write(join(root, 'research', 'unlisted.md'), 'on disk, not listed\n');
  write(join(root, 'billing', 'SKILL.md'), '---\nname: billing\n---\n');
  write(join(root, 'billing', 'rates.md'), 'the other skill\n');
  write(join(base, 'secret.txt'), 'NOT FOR THE MODEL\n');
  const tool = readSkillFileTool(root, [{ name: 'research', files: ['SKILL.md', 'reference/sources.md', 'reference/linked.md', 'via/file.md'] }, { name: 'billing', files: ['SKILL.md', 'rates.md'] }]);
  return { base, root, tool };
}
const call = (tool, args) => tool.call(args, { callId: 'c1', signal: new AbortController().signal });

test("a listed file of a skill reads, its exact text; the tool is replay-safe and names the host's skills", async () => {
  const { tool } = skills();
  assert.equal(tool.name, READ_SKILL_FILE);
  assert.equal(tool.replay, 'safe');
  assert.deepEqual(tool.inputSchema.properties.skill.enum, ['research', 'billing']);
  assert.deepEqual(await call(tool, { skill: 'research', path: 'reference/sources.md' }), { text: 'Primary sources first. ✓\n' });
  assert.deepEqual(await call(tool, { skill: 'billing', path: 'rates.md' }), { text: 'the other skill\n' });
});

test('refused, each by name: an unlisted path, a climbing or absolute one (before any filesystem call), an unknown skill, another skill\'s file', async () => {
  const { tool } = skills();
  for (const [args, said] of [
    [{ skill: 'research', path: 'unlisted.md' }, /"unlisted.md" is not one of the skill research's files/],
    [{ skill: 'research', path: '../billing/rates.md' }, /absolute or climbs/],
    [{ skill: 'research', path: '../../secret.txt' }, /absolute or climbs/],
    [{ skill: 'research', path: '/etc/passwd' }, /absolute or climbs/],
    [{ skill: 'research', path: 'reference/../SKILL.md' }, /absolute or climbs/],
    [{ skill: 'research', path: 'rates.md' }, /"rates.md" is not one of the skill research's files/],
    [{ skill: 'nobody', path: 'SKILL.md' }, /"nobody" is not one of your skills/],
    [{ skill: 'research' }, /give a skill's name and a file's path/],
  ]) {
    const result = await call(tool, args);
    assert.ok(result.isError && said.test(result.text), `${JSON.stringify(args)}: ${result.text}`);
  }
  // Refused before the disk: the same checks answer for a root that does not exist.
  const blind = readSkillFileTool(join(ROOT, 'no-such-root'), [{ name: 'research', files: ['SKILL.md'] }]);
  assert.match((await call(blind, { skill: 'research', path: '../x' })).text, /absolute or climbs/);
});

test('no link is followed: a listed file that is a link, or a listed path through a linked directory, is refused', async () => {
  const { base, root, tool } = skills();
  symlinkSync(join(base, 'secret.txt'), join(root, 'research', 'reference', 'linked.md'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'file.md'), 'NOT FOR THE MODEL\n');
  symlinkSync(join(base, 'outside'), join(root, 'research', 'via'));
  for (const path of ['reference/linked.md', 'via/file.md']) {
    const result = await call(tool, { skill: 'research', path });
    assert.ok(result.isError && /link/.test(result.text) && !result.text.includes('NOT FOR THE MODEL'), `${path}: ${result.text}`);
  }
});

test("a skill whose own directory is a link is refused: the link's target never becomes the trusted base, though it holds a listed file", async () => {
  const base = mkdtempSync(join(ROOT, 'linked-dir-'));
  const root = join(base, 'skills');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'SKILL.md'), 'OUTSIDE THE SKILLS ROOT\n');
  symlinkSync(outside, join(root, 'research'));
  const tool = readSkillFileTool(root, [{ name: 'research', files: ['SKILL.md'] }]);
  const result = await call(tool, { skill: 'research', path: 'SKILL.md' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.text, /link/);
  assert.ok(!result.text.includes('OUTSIDE'), 'nothing of the target was read');
});

test("a skills root reached through a link (as /tmp is on some machines) still reads", async () => {
  const base = mkdtempSync(join(ROOT, 'linked-root-'));
  const real = join(base, 'real');
  mkdirSync(join(real, 'research'), { recursive: true });
  writeFileSync(join(real, 'research', 'SKILL.md'), 'inside\n');
  symlinkSync(real, join(base, 'skills'));
  const tool = readSkillFileTool(join(base, 'skills'), [{ name: 'research', files: ['SKILL.md'] }]);
  assert.deepEqual(await call(tool, { skill: 'research', path: 'SKILL.md' }), { text: 'inside\n' });
});

test("skillProblems, the check every adapter runs on a host's skills: a plain name, a SKILL.md that names it with a description, plain relative paths, 1 MiB in all", async () => {
  const { skillProblems } = await import('@parcha/agentrun-adapters');
  assert.equal(typeof skillProblems, 'function', '@parcha/agentrun-adapters exports skillProblems');
  const md = (name, extra = 'description: d') => `---\nname: ${name}\n${extra}\n---\nbody\n`;
  const wrong = (skill) => skillProblems([skill]).join('; ');
  assert.deepEqual(skillProblems([{ name: 'research', files: { 'SKILL.md': md('research'), 'reference/sources.md': 'x' } }]), []);
  assert.match(wrong({ name: 'Bad Name', files: { 'SKILL.md': md('Bad Name') } }), /not lowercase letters, digits and dashes/);
  assert.match(wrong({ name: 'a', files: {} }), /no SKILL.md with front matter/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('b') } }), /names it otherwise/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a', 'other: x') } }), /no description/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), '../escape.md': 'x' } }), /not a plain relative path/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), reference: 'x', 'reference/sources.md': 'y' } }), /reference is both a file and a folder/);
  assert.match(skillProblems([{ name: 'a', files: { 'SKILL.md': md('a') } }, { name: 'a', files: { 'SKILL.md': md('a') } }]).join(';'), /given twice/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), 'big.md': 'x'.repeat(1024 * 1024) } }), /more than 1048576/);
});
