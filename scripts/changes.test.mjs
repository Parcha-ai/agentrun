import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bulletOf, fold, hasVersionSection, loadFragments, parseFragment, unreleasedEdits, unreleasedSection } from './changes.mjs';

const exec = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), 'changes.mjs');
const known = new Set(['@parcha/agentrun-dsl', '@parcha/pi-vision']);
const fragment = (packages, kind, body) => `---\npackages: ${packages}\nkind: ${kind}\n---\n${body}\n`;

const rootLog = '# Changelog\n\n## Unreleased\n\n- Existing root bullet.\n\n## 0.1.0-beta.12, 2026-10-09\n\n- Older.\n';
const visionLog = '# Changelog\n\n## Unreleased\n\n- Existing vision bullet.\n';

async function repo(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-changes-'));
  try {
    for (const [directory, name] of [['dsl', '@parcha/agentrun-dsl'], ['pi-vision', '@parcha/pi-vision']]) {
      await mkdir(join(root, 'packages', directory), { recursive: true });
      await writeFile(join(root, 'packages', directory, 'package.json'), JSON.stringify({ name }));
    }
    await mkdir(join(root, 'changes'));
    await writeFile(join(root, 'changes/README.md'), 'How to add a change.\n');
    await writeFile(join(root, 'CHANGELOG.md'), rootLog);
    await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), visionLog);
    const git = (...args) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
    await git('init', '-q'); await git('add', '-A'); await git('commit', '-q', '-m', 'base');
    await fn(root, git);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('a fragment needs front matter, a known package, a known kind and a body without a bullet', () => {
  assert.deepEqual(parseFragment(fragment('@parcha/pi-vision, repo', 'fix', 'Text.'), 'f', known), { packages: ['@parcha/pi-vision', 'repo'], kind: 'fix', body: 'Text.' });
  assert.throws(() => parseFragment('Text.\n', 'f', known), /front matter/);
  assert.throws(() => parseFragment(fragment('@parcha/nope', 'fix', 'Text.'), 'f', known), /not repo or a workspace package/);
  assert.throws(() => parseFragment(fragment('repo', 'chore', 'Text.'), 'f', known), /kind is one of/);
  assert.throws(() => parseFragment(fragment('repo', 'fix', ''), 'f', known), /empty/);
  assert.throws(() => parseFragment(fragment('repo', 'fix', '- Text.'), 'f', known), /without the leading bullet/);
  assert.throws(() => parseFragment('---\npackages: repo\nkind: fix\nextra: 1\n---\nText.\n', 'f', known), /only packages and kind/);
});

test('loadFragments reads changes/ and skips its README', () => repo(async root => {
  await writeFile(join(root, 'changes/b-change.md'), fragment('repo', 'ci', 'B.'));
  await writeFile(join(root, 'changes/a-change.md'), fragment('@parcha/agentrun-dsl', 'feature', 'A.'));
  assert.deepEqual((await loadFragments(root)).map(entry => entry.file), ['a-change.md', 'b-change.md']);
  await writeFile(join(root, 'changes/Bad Name.md'), fragment('repo', 'fix', 'X.'));
  await assert.rejects(loadFragments(root), /lowercase letters/);
}));

test('a fold turns Unreleased into the version, bullets first, and opens a new Unreleased above it', () => repo(async root => {
  await writeFile(join(root, 'changes/vision-fix.md'), fragment('@parcha/pi-vision', 'fix', 'Vision fix.\n\n- Detail.'));
  await writeFile(join(root, 'changes/dsl-feature.md'), fragment('@parcha/agentrun-dsl', 'feature', 'Core feature.'));
  await writeFile(join(root, 'changes/breaking.md'), fragment('repo', 'breaking', 'Breaking change.'));
  const result = await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal(result.folded, 3);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Existing root bullet.\n- Breaking change.\n- Core feature.\n\n## 0.1.0-beta.12, 2026-10-09\n\n- Older.\n');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Existing vision bullet.\n- Vision fix.\n\n  - Detail.\n');
  assert.deepEqual(await loadFragments(root), []);
  const log = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(hasVersionSection(log, '0.1.0-beta.13') && !hasVersionSection(log, '0.1.0-beta.1'));
}));

test('a package changelog that gets no fragment is untouched', () => repo(async root => {
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), visionLog);
}));

test('a second fold with no fragments and an empty Unreleased does nothing', () => repo(async root => {
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  const folded = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual((await fold(root, '0.1.0-beta.13', '2026-10-21')).files, []);
  assert.deepEqual((await fold(root, '0.1.0-beta.14', '2026-10-22')).files, []);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), folded);
}));

test("the repository's own CHANGELOG plus two fragments folds into the released shape", () => repo(async root => {
  const real = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
  await writeFile(join(root, 'CHANGELOG.md'), real);
  await writeFile(join(root, 'changes/a.md'), fragment('repo', 'feature', 'First new change.'));
  await writeFile(join(root, 'changes/b.md'), fragment('@parcha/agentrun-dsl', 'fix', 'Second new change.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  const folded = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const held = unreleasedSection(real).split('\n').slice(1).join('\n').trim();
  const rest = real.slice(real.indexOf('\n## ', real.indexOf('## Unreleased') + 1) + 1);
  assert.equal(folded, `# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.13 (2026-10-20)\n\n${held}\n- First new change.\n- Second new change.\n\n${rest}`.replace(/\n*$/, '\n'));
  assert.equal(unreleasedSection(folded), '## Unreleased\n');
}));

test('a second fold of the same version appends to its section', () => repo(async root => {
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  await writeFile(join(root, 'changes/two.md'), fragment('repo', 'fix', 'Two.'));
  await fold(root, '0.1.0-beta.13', '2026-10-21');
  const log = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(log.match(/## 0\.1\.0-beta\.13/g).length, 1);
  assert.match(log, /- One\.\n- Two\.\n\n## 0\.1\.0-beta\.12/);
}));

test('a fragment naming two packages folds into each changelog once', () => repo(async root => {
  await writeFile(join(root, 'changes/both.md'), fragment('@parcha/pi-vision, @parcha/agentrun-dsl, repo', 'feature', 'Both.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal((await readFile(join(root, 'CHANGELOG.md'), 'utf8')).match(/- Both\./g).length, 1);
  assert.equal((await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8')).match(/- Both\./g).length, 1);
}));

test('editing an Unreleased section fails; adding a fragment does not', () => repo(async root => {
  await writeFile(join(root, 'changes/new.md'), fragment('repo', 'fix', 'New.'));
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: false, edited: [] });
  await writeFile(join(root, 'CHANGELOG.md'), rootLog.replace('- Existing root bullet.', '- Existing root bullet.\n- Another.'));
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, ['CHANGELOG.md']);
  await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), visionLog + '- Edited.\n');
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']);
}));

test('an edit outside an Unreleased section is not an Unreleased edit', () => repo(async root => {
  await writeFile(join(root, 'CHANGELOG.md'), rootLog.replace('- Older.', '- Older, dated.'));
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, []);
}));

test('the fold, which deletes fragments and adds none, passes', () => repo(async (root, git) => {
  await writeFile(join(root, 'changes/pending.md'), fragment('repo', 'fix', 'Pending.'));
  await git('add', '-A'); await git('commit', '-q', '-m', 'a fragment');
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  await writeFile(join(root, 'CHANGELOG.md'), (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).replace('- Existing root bullet.', '- Existing root bullet, renamed by the release.'));
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: true, edited: [] });
  await writeFile(join(root, 'changes/extra.md'), fragment('repo', 'fix', 'Extra.'));
  assert.equal((await unreleasedEdits(root, 'HEAD')).fold, false);
}));

test('the command line fails an Unreleased edit and passes a fragment', () => repo(async (root, git) => {
  const { stdout: base } = await git('rev-parse', 'HEAD');
  const run = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  // The script validates the repository it lives in; copy it beside the fixture so it reads this one.
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/changes.mjs'), await readFile(script, 'utf8'));
  const local = args => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'changes/ok.md'), fragment('repo', 'fix', 'Ok.'));
  const pass = local(['--check', '--base', base.trim()]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /1 fragment\(s\) valid; no Unreleased section edited/);
  await writeFile(join(root, 'CHANGELOG.md'), rootLog.replace('- Existing root bullet.', '- Sneaked in.'));
  const fail = local(['--check', '--base', base.trim()]);
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /Unreleased section is edited in CHANGELOG\.md/);
  assert.equal(run(['--bogus']).status, 1);
}));

test('a bullet indents the continuation lines under the first', () => {
  assert.equal(bulletOf('First.\n\nSecond paragraph.\n- Nested.'), '- First.\n\n  Second paragraph.\n  - Nested.');
});
