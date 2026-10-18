import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bulletOf, fold, hasVersionSection, loadFragments, parseFragment, releaseRace, unreleasedEdits, unreleasedSection } from './changes.mjs';

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

test('a package changelog that holds bullets and gets no fragment is dated by the fold, and a fresh Unreleased opens above it', () => repo(async root => {
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  const result = await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.deepEqual(result.files, ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']);
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Existing vision bullet.\n');
}));

test('with no fragment at all, a changelog that holds bullets is still dated', () => repo(async root => {
  const result = await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.deepEqual(result.files, ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']);
  assert.match(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), /## Unreleased\n\n## 0\.1\.0-beta\.13 \(2026-10-20\)\n\n- Existing root bullet\.\n/);
}));

test('a package changelog with nothing held and no fragment is untouched, also when it has no Unreleased heading or no file', () => repo(async root => {
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  const emptyLog = '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.12, 2026-10-09\n\n- Older.\n';
  await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), emptyLog);
  assert.deepEqual((await fold(root, '0.1.0-beta.13', '2026-10-20')).files, ['CHANGELOG.md']);
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), emptyLog);
  const noHeading = '# Changelog\n\n## 0.1.0-beta.12, 2026-10-09\n\n- Older.\n';
  await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), noHeading);
  await writeFile(join(root, 'changes/two.md'), fragment('repo', 'fix', 'Two.'));
  await fold(root, '0.1.0-beta.14', '2026-10-21');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), noHeading);
  // packages/dsl has no CHANGELOG.md in this repo: the fold does not look for one it was not given.
}));

/** A held package under `root`: its manifest says private, and its changelog holds `log`. */
async function heldPackage(root, log) {
  await mkdir(join(root, 'packages/pi-transport'), { recursive: true });
  await writeFile(join(root, 'packages/pi-transport/package.json'), JSON.stringify({ name: '@parcha/pi-transport', private: true }));
  await writeFile(join(root, 'packages/pi-transport/CHANGELOG.md'), log);
}
const heldLog = '# Changelog\n\n## [Unreleased]\n\n- Held entry.\n';

test("a held package's changelog is never dated: its fragments join its Unreleased section, and a published one is dated as before", () => repo(async root => {
  await heldPackage(root, heldLog);
  await writeFile(join(root, 'changes/held.md'), fragment('@parcha/pi-transport', 'feature', 'Held fragment.\n\n- Detail.'));
  await writeFile(join(root, 'changes/vision.md'), fragment('@parcha/pi-vision', 'fix', 'Vision fix.'));
  const result = await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.deepEqual(result.files, ['CHANGELOG.md', 'packages/pi-transport/CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']);
  assert.equal(await readFile(join(root, 'packages/pi-transport/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## [Unreleased]\n\n- Held entry.\n- Held fragment.\n\n  - Detail.\n', 'no version heading, the entry kept, the fragment appended');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Existing vision bullet.\n- Vision fix.\n', 'a published package is dated');
  assert.deepEqual(await loadFragments(root), [], 'the held fragment is deleted like every other');
}));

test("held means the manifest says private, not a package's name: a private package is undated, and pi-transport is dated once its hold is lifted", () => repo(async root => {
  await writeFile(join(root, 'packages/pi-vision/package.json'), JSON.stringify({ name: '@parcha/pi-vision', private: true }));
  await heldPackage(root, heldLog);
  await writeFile(join(root, 'packages/pi-transport/package.json'), JSON.stringify({ name: '@parcha/pi-transport' }));
  await writeFile(join(root, 'changes/vision.md'), fragment('@parcha/pi-vision', 'fix', 'Vision fix.'));
  await writeFile(join(root, 'changes/transport.md'), fragment('@parcha/pi-transport', 'fix', 'Transport fix.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), '# Changelog\n\n## Unreleased\n\n- Existing vision bullet.\n- Vision fix.\n');
  assert.equal(await readFile(join(root, 'packages/pi-transport/CHANGELOG.md'), 'utf8'), '# Changelog\n\n## [Unreleased]\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Held entry.\n- Transport fix.\n');
}));

/** A committed tree with a held package, its entry and `fragments` (name to text); the held changelog is `heldLog`. */
async function heldTree(root, git, fragments) {
  await heldPackage(root, heldLog);
  for (const [name, text] of Object.entries(fragments)) await writeFile(join(root, 'changes', name), text);
  await git('add', '-A'); await git('commit', '-q', '-m', 'held package and its fragments');
}
const heldPath = 'packages/pi-transport/CHANGELOG.md';

test("the fold's own change passes the Unreleased check, a held package's appended fragments included", () => repo(async (root, git) => {
  await heldTree(root, git, { 'a-feature.md': fragment('@parcha/pi-transport', 'feature', 'Held feature.'), 'b-breaking.md': fragment('@parcha/pi-transport', 'breaking', 'Held breaking.') });
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.match(await readFile(join(root, heldPath), 'utf8'), /- Held entry\.\n- Held breaking\.\n- Held feature\.\n/, 'in the fold\'s order: breaking before feature');
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: true, edited: [] });
}));

test("a fold that changes only a held package's changelog is still the fold", () => repo(async (root, git) => {
  await heldTree(root, git, { 'held.md': fragment('@parcha/pi-transport', 'fix', 'Held fix.') });
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  await git('checkout', '-q', 'HEAD', '--', 'CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md');
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: true, edited: [] });
}));

test("an edit of a held package's Unreleased is still refused: appended by hand, without the fragment gone, or not the fragment's text, or out of the fold's order", () => repo(async (root, git) => {
  await heldTree(root, git, { 'a-feature.md': fragment('@parcha/pi-transport', 'feature', 'Held feature.'), 'b-breaking.md': fragment('@parcha/pi-transport', 'breaking', 'Held breaking.') });
  const append = text => writeFile(join(root, heldPath), text);
  // by hand, no fragment deleted
  await append(`${heldLog}- Written by hand.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, [heldPath]);
  // the fragments deleted, the text appended is not theirs
  await rm(join(root, 'changes/a-feature.md')); await rm(join(root, 'changes/b-breaking.md'));
  await append(`${heldLog}- Something else.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, [heldPath]);
  // their text, in the wrong order
  await append(`${heldLog}- Held feature.\n- Held breaking.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, [heldPath], 'the fold writes breaking first');
  // their text, in the fold's order, plus a line of the author's
  await append(`${heldLog}- Held breaking.\n- Held feature.\n- And one more.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, [heldPath]);
  // exactly the fold's result
  await append(`${heldLog}- Held breaking.\n- Held feature.\n`);
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: true, edited: [] });
}));

/** The release PR that folds, merges main, then folds a late fragment in a second commit: `late` is a fragment main gained after the first fold. */
async function foldInTwoBatches(root, git, first, late) {
  await git('branch', '-M', 'main');
  await heldTree(root, git, first);
  await git('checkout', '-q', '-b', 'release');
  await fold(root, '0.1.0-beta.15', '2026-10-20', 'main');
  await git('add', '-A'); await git('commit', '-q', '-m', 'fold');
  await git('checkout', '-q', 'main');
  for (const [name, text] of Object.entries(late)) await writeFile(join(root, 'changes', name), text);
  await git('add', '-A'); await git('commit', '-q', '-m', 'a late fragment lands on main');
  await git('checkout', '-q', 'release');
  await git('merge', '-q', '--no-edit', 'main');
  return fold(root, '0.1.0-beta.15', '2026-10-20', 'main');
}

test("a held package's changelog folded in two commits (a late fragment that sorts earlier) is the single fold's text, and passes the check", () => repo(async (root, git) => {
  await foldInTwoBatches(root, git,
    { 'pi-transport-record-stream.md': fragment('@parcha/pi-transport', 'feature', 'Record stream.'), 'pi-transport-tests-leave-no-sleeper.md': fragment('@parcha/pi-transport', 'ci', 'No sleeper.') },
    { 'pi-transport-placer.md': fragment('@parcha/pi-transport', 'feature', 'Placer.') });
  // The single fold's order: kind, then file name: placer, record-stream (features), then no-sleeper (ci).
  assert.equal(await readFile(join(root, heldPath), 'utf8'), `${heldLog}- Placer.\n- Record stream.\n- No sleeper.\n`);
  assert.deepEqual(await unreleasedEdits(root, 'main'), { fold: true, edited: [] });
  // The same three in one fold give the same text.
  await repo(async single => {
    await heldPackage(single, heldLog);
    for (const [name, kind, body] of [['record-stream', 'feature', 'Record stream.'], ['tests-leave-no-sleeper', 'ci', 'No sleeper.'], ['placer', 'feature', 'Placer.']]) {
      await writeFile(join(single, `changes/pi-transport-${name}.md`), fragment('@parcha/pi-transport', kind, body));
    }
    await fold(single, '0.1.0-beta.15', '2026-10-20');
    assert.equal(await readFile(join(single, heldPath), 'utf8'), `${heldLog}- Placer.\n- Record stream.\n- No sleeper.\n`);
  });
}));

test("a second fold keeps a held changelog's earlier text where it was: only this release's run is rebuilt", () => repo(async (root, git) => {
  await foldInTwoBatches(root, git,
    { 'pi-transport-record-stream.md': fragment('@parcha/pi-transport', 'feature', 'Record stream.') },
    { 'pi-transport-placer.md': fragment('@parcha/pi-transport', 'breaking', 'Placer.') });
  assert.equal(await readFile(join(root, heldPath), 'utf8'), `${heldLog}- Placer.\n- Record stream.\n`, 'the held entry stays first');
}));

/** The same for published changelogs: the release folds, main takes `late` fragments, the release merges main and folds again. */
async function foldPublishedInTwoBatches(root, git, first, late) {
  await git('branch', '-M', 'main');
  for (const [name, text] of Object.entries(first)) await writeFile(join(root, 'changes', name), text);
  await git('add', '-A'); await git('commit', '-q', '-m', 'fragments');
  await git('checkout', '-q', '-b', 'release');
  await fold(root, '0.1.0-beta.16', '2026-10-18', 'main');
  await git('add', '-A'); await git('commit', '-q', '-m', 'fold');
  await git('checkout', '-q', 'main');
  for (const [name, text] of Object.entries(late)) await writeFile(join(root, 'changes', name), text);
  await git('add', '-A'); await git('commit', '-q', '-m', 'late fragments land on main');
  await git('checkout', '-q', 'release');
  await git('merge', '-q', '--no-edit', 'main');
  return fold(root, '0.1.0-beta.16', '2026-10-18', 'main');
}

test("a published changelog folded in two commits (a late fix that sorts between two earlier ones) is the single fold's text, in the root and in a package", () => repo(async (root, git) => {
  const both = (name, kind, body) => ({ [`${name}.md`]: fragment('repo, @parcha/pi-vision', kind, body) });
  await foldPublishedInTwoBatches(root, git,
    { ...both('recording-validator-fixes', 'fix', 'Validator fixes.'), ...both('viewer-skip-temp-blobs', 'fix', 'Skip temp blobs.'), ...both('docs-look', 'docs', 'Look docs.'), ...both('feature-find', 'feature', 'Find.') },
    both('recording-spaces-fix', 'fix', 'Spaces fix.'));
  // One fold's order: the section's own earlier bullet, then feature, fix (by file name), docs.
  const bulletsOf = text => text.slice(text.indexOf('## 0.1.0-beta.16'), text.indexOf('## 0.1.0-beta.12')).split('\n').filter(line => line.startsWith('- '));
  const order = ['- Existing root bullet.', '- Find.', '- Spaces fix.', '- Validator fixes.', '- Skip temp blobs.', '- Look docs.'];
  assert.deepEqual(bulletsOf(await readFile(join(root, 'CHANGELOG.md'), 'utf8')), order);
  assert.deepEqual(await unreleasedEdits(root, 'main'), { fold: true, edited: [] });
  // The same fragments folded once in a fresh repo give the same changelogs.
  await repo(async single => {
    for (const [name, kind, body] of [['recording-validator-fixes', 'fix', 'Validator fixes.'], ['viewer-skip-temp-blobs', 'fix', 'Skip temp blobs.'], ['docs-look', 'docs', 'Look docs.'], ['feature-find', 'feature', 'Find.'], ['recording-spaces-fix', 'fix', 'Spaces fix.']]) {
      await writeFile(join(single, `changes/${name}.md`), fragment('repo, @parcha/pi-vision', kind, body));
    }
    await fold(single, '0.1.0-beta.16', '2026-10-18');
    for (const file of ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']) assert.equal(await readFile(join(root, file), 'utf8'), await readFile(join(single, file), 'utf8'), file);
  });
}));

test("a published changelog hand-edited between the two folds is not rebuilt: the late bullet goes at the end of the section, and the check refuses it", () => repo(async (root, git) => {
  await git('branch', '-M', 'main');
  await writeFile(join(root, 'changes/a-fix.md'), fragment('repo', 'fix', 'A fix.'));
  await git('add', '-A'); await git('commit', '-q', '-m', 'fragments');
  await git('checkout', '-q', '-b', 'release');
  await fold(root, '0.1.0-beta.16', '2026-10-18', 'main');
  await writeFile(join(root, 'CHANGELOG.md'), (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).replace('- A fix.\n', '- A fix.\n- Written by hand.\n'));
  await git('add', '-A'); await git('commit', '-q', '-m', 'fold, and a hand edit');
  await git('checkout', '-q', 'main');
  await writeFile(join(root, 'changes/0-late.md'), fragment('repo', 'feature', 'Late feature.'));
  await git('add', '-A'); await git('commit', '-q', '-m', 'a late fragment lands on main');
  await git('checkout', '-q', 'release');
  await git('merge', '-q', '--no-edit', 'main');
  await fold(root, '0.1.0-beta.16', '2026-10-18', 'main');
  assert.match(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), /- A fix\.\n- Written by hand\.\n- Late feature\.\n/);
}));

test("a held changelog hand-edited between the two folds is not rebuilt: the late bullet is appended after it, and the check refuses the edit", () => repo(async (root, git) => {
  await git('branch', '-M', 'main');
  await heldTree(root, git, { 'pi-transport-record-stream.md': fragment('@parcha/pi-transport', 'feature', 'Record stream.') });
  await git('checkout', '-q', '-b', 'release');
  await fold(root, '0.1.0-beta.15', '2026-10-20', 'main');
  await writeFile(join(root, heldPath), `${await readFile(join(root, heldPath), 'utf8')}- Written by hand.\n`);
  await git('add', '-A'); await git('commit', '-q', '-m', 'fold, and a hand edit');
  await git('checkout', '-q', 'main');
  await writeFile(join(root, 'changes/pi-transport-placer.md'), fragment('@parcha/pi-transport', 'breaking', 'Placer.'));
  await git('add', '-A'); await git('commit', '-q', '-m', 'a late fragment lands on main');
  await git('checkout', '-q', 'release');
  await git('merge', '-q', '--no-edit', 'main');
  await fold(root, '0.1.0-beta.15', '2026-10-20', 'main');
  assert.equal(await readFile(join(root, heldPath), 'utf8'), `${heldLog}- Record stream.\n- Written by hand.\n- Placer.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'main')).edited, [heldPath]);
}));

test("a fragment deleted for another package does not excuse an edit of a held changelog, and a published changelog is never excused by one", () => repo(async (root, git) => {
  await heldTree(root, git, { 'vision.md': fragment('@parcha/pi-vision', 'fix', 'Vision fix.') });
  await rm(join(root, 'changes/vision.md'));
  await writeFile(join(root, heldPath), `${heldLog}- Vision fix.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, [heldPath], 'the deleted fragment names pi-vision, not the held package');
  await writeFile(join(root, heldPath), heldLog);
  await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), `${visionLog}- Vision fix.\n`);
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, ['packages/pi-vision/CHANGELOG.md'], 'appending to a published changelog is an edit even with its fragment gone');
}));

test("a held package with an empty Unreleased gets its fragment under it, undated", () => repo(async root => {
  await heldPackage(root, '# Changelog\n\n## Unreleased\n');
  await writeFile(join(root, 'changes/held.md'), fragment('@parcha/pi-transport', 'feature', 'First entry.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal(await readFile(join(root, 'packages/pi-transport/CHANGELOG.md'), 'utf8'), '# Changelog\n\n## Unreleased\n\n- First entry.\n');
}));

test("a held package with entries and no fragment is left as it is, never dated", () => repo(async root => {
  await heldPackage(root, heldLog);
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  const result = await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.ok(!result.files.includes('packages/pi-transport/CHANGELOG.md'));
  assert.equal(await readFile(join(root, 'packages/pi-transport/CHANGELOG.md'), 'utf8'), heldLog);
}));

test("a held package whose changelog already has the version's section still gets its fragments under Unreleased", () => repo(async root => {
  const dated = '# Changelog\n\n## [Unreleased]\n\n## 0.1.0-beta.13 (2026-10-19)\n\n- Dated by mistake.\n';
  await heldPackage(root, dated);
  await writeFile(join(root, 'changes/held.md'), fragment('@parcha/pi-transport', 'fix', 'Held fix.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal(await readFile(join(root, 'packages/pi-transport/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## [Unreleased]\n\n- Held fix.\n\n## 0.1.0-beta.13 (2026-10-19)\n\n- Dated by mistake.\n');
}));

test("a held package's changelog without an Unreleased heading is refused when a fragment names it, never silently dropped", () => repo(async root => {
  await heldPackage(root, '# Changelog\n\n## 0.1.0-beta.12, 2026-10-09\n\n- Older.\n');
  await writeFile(join(root, 'changes/held.md'), fragment('@parcha/pi-transport', 'fix', 'Held fix.'));
  await assert.rejects(fold(root, '0.1.0-beta.13', '2026-10-20'), /no Unreleased heading to add to/);
  assert.equal((await loadFragments(root)).length, 1, 'nothing was written and the fragment is still there');
}));

test('a second fold with no fragments and an empty Unreleased does nothing', () => repo(async root => {
  await writeFile(join(root, 'changes/one.md'), fragment('repo', 'fix', 'One.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  const folded = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual((await fold(root, '0.1.0-beta.13', '2026-10-21')).files, []);
  assert.deepEqual((await fold(root, '0.1.0-beta.14', '2026-10-22')).files, []);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), folded);
}));

/** `text` with its Unreleased section emptied: the state of a changelog right after a release fold. */
const withEmptyUnreleased = text => text.replace(/(^## Unreleased\n)[\s\S]*?(?=^## )/m, '$1\n');

// A version the real changelog can never hold: a release commit already has its own version's section, and folding that version would take
// the append-to-an-existing-section path instead of the one these tests are about.
const FOLDED = '0.0.0-test.1';
for (const [name, prepare] of [
  ["the repository's own CHANGELOG plus two fragments folds into the released shape", text => text],
  ["the repository's own CHANGELOG with an empty Unreleased plus two fragments folds into the released shape", withEmptyUnreleased],
]) {
  test(name, () => repo(async root => {
    const real = prepare(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8'));
    await writeFile(join(root, 'CHANGELOG.md'), real);
    await writeFile(join(root, 'changes/a.md'), fragment('repo', 'feature', 'First new change.'));
    await writeFile(join(root, 'changes/b.md'), fragment('@parcha/agentrun-dsl', 'fix', 'Second new change.'));
    await fold(root, FOLDED, '2026-10-20');
    const folded = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
    const held = unreleasedSection(real).split('\n').slice(1).join('\n').trim();
    const rest = real.slice(real.indexOf('\n## ', real.indexOf('## Unreleased') + 1) + 1);
    assert.equal(folded, `# Changelog\n\n## Unreleased\n\n## ${FOLDED} (2026-10-20)\n\n${held ? `${held}\n` : ''}- First new change.\n- Second new change.\n\n${rest}`.replace(/\n*$/, '\n'));
    assert.equal(unreleasedSection(folded), '## Unreleased\n');
  }));
}

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

test('the fold passes, also beside a fragment another change adds; filling an Unreleased section does not', () => repo(async (root, git) => {
  await writeFile(join(root, 'changes/pending.md'), fragment('repo', 'fix', 'Pending.'));
  await git('add', '-A'); await git('commit', '-q', '-m', 'a fragment');
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: true, edited: [] });
  await writeFile(join(root, 'changes/extra.md'), fragment('repo', 'fix', 'Extra.'));
  assert.deepEqual(await unreleasedEdits(root, 'HEAD'), { fold: true, edited: [] });
  await writeFile(join(root, 'CHANGELOG.md'), (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).replace('## Unreleased\n', '## Unreleased\n\n- Sneaked in.\n'));
  assert.deepEqual((await unreleasedEdits(root, 'HEAD')).edited, ['CHANGELOG.md']);
}));

test('a fragment saved with CRLF line endings parses', () => {
  assert.deepEqual(parseFragment(fragment('repo', 'fix', 'Text.\nMore.').replace(/\n/g, '\r\n'), 'f', known), { packages: ['repo'], kind: 'fix', body: 'Text.\nMore.' });
});

test('a misnamed file in changes/ is refused, not skipped', () => repo(async root => {
  for (const name of ['fix.MD', 'fix.txt', '.gitkeep']) {
    await writeFile(join(root, 'changes', name), fragment('repo', 'fix', 'X.'));
    await assert.rejects(loadFragments(root), /nothing else belongs in changes/, name);
    await rm(join(root, 'changes', name));
  }
}));

test('a release of package fragments only still gets the root section the preflight needs', () => repo(async root => {
  await writeFile(join(root, 'changes/vision.md'), fragment('@parcha/pi-vision', 'fix', 'Vision only.'));
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  await fold(root, '0.1.0-beta.14', '2026-10-21');
  await writeFile(join(root, 'changes/vision2.md'), fragment('@parcha/pi-vision', 'fix', 'Vision again.'));
  await fold(root, '0.1.0-beta.15', '2026-10-22');
  const log = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(hasVersionSection(log, '0.1.0-beta.15'));
  assert.match(log, /## Unreleased\n\n## 0\.1\.0-beta\.15 \(2026-10-22\)\n\n- Package changes only; see the package changelogs\.\n\n## 0\.1\.0-beta\.13 \(2026-10-20\)/);
}));

test('a fold that fails part way leaves every file as it was, so a retry adds nothing twice', { skip: process.getuid?.() === 0 }, () => repo(async root => {
  await writeFile(join(root, 'changes/root.md'), fragment('repo', 'fix', 'Root.'));
  await writeFile(join(root, 'changes/vision.md'), fragment('@parcha/pi-vision', 'fix', 'Vision.'));
  await chmod(join(root, 'packages/pi-vision/CHANGELOG.md'), 0o444);
  await assert.rejects(fold(root, '0.1.0-beta.13', '2026-10-20'), /EACCES/);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), rootLog);
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), visionLog);
  assert.deepEqual((await loadFragments(root)).map(entry => entry.file), ['root.md', 'vision.md']);
  await chmod(join(root, 'packages/pi-vision/CHANGELOG.md'), 0o644);
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.equal((await readFile(join(root, 'CHANGELOG.md'), 'utf8')).match(/- Root\./g).length, 1);
  assert.equal((await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8')).match(/- Vision\./g).length, 1);
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

// The release race: a fold made on one main, merged after another pull request added a fragment.
const bump = async (root, version) => {
  for (const directory of ['dsl', 'pi-vision']) {
    const path = join(root, 'packages', directory, 'package.json');
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version }));
  }
};
const commitAll = async (git, message) => { await git('add', '-A'); await git('commit', '-q', '-m', message); };
const withVersion = async (root, git) => { await bump(root, '0.1.0-beta.13'); await commitAll(git, 'versions'); };

test('releaseRace: a version bump beside a fragment the fold did not see is refused, naming it', () => repo(async (root, git) => {
  await withVersion(root, git);
  await writeFile(join(root, 'changes/late.md'), fragment('repo', 'fix', 'Late.'));
  await commitAll(git, 'a late fragment');
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await bump(root, '0.1.0-beta.14');
  assert.deepEqual(await releaseRace(root, base.trim()), { release: true, bumped: ['dsl', 'pi-vision'], unfolded: ['late.md'] });
}));
test('releaseRace: a bump with only the README in changes/ is the release', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await bump(root, '0.1.0-beta.14');
  assert.deepEqual(await releaseRace(root, base.trim()), { release: true, bumped: ['dsl', 'pi-vision'], unfolded: [] });
}));
test('releaseRace: a pull request with fragments and no version change is untouched, also when it adds a package', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'changes/normal.md'), fragment('repo', 'fix', 'Normal.'));
  await mkdir(join(root, 'packages/new'));
  await writeFile(join(root, 'packages/new/package.json'), JSON.stringify({ name: '@parcha/new', version: '0.0.1' }));
  assert.deepEqual(await releaseRace(root, base.trim()), { release: false, bumped: [], unfolded: [] });
}));
test('releaseRace: in the merge queue the base holds an earlier pull request\'s fragment, and the release on it is refused', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: main } = await git('rev-parse', 'HEAD');
  // The release pull request: folded and bumped on main as it was.
  await git('checkout', '-q', '-b', 'release');
  await bump(root, '0.1.0-beta.14');
  await commitAll(git, 'release');
  // The queue's base moved: an earlier pull request added a fragment.
  await git('checkout', '-q', '-b', 'queue-base', main.trim());
  await writeFile(join(root, 'changes/earlier.md'), fragment('repo', 'fix', 'Earlier.'));
  await commitAll(git, 'earlier pull request');
  const { stdout: groupBase } = await git('rev-parse', 'HEAD');
  await git('merge', '-q', '--no-ff', '-m', 'merge group', 'release');
  assert.deepEqual((await releaseRace(root, groupBase.trim())).unfolded, ['earlier.md']);
}));
test('the command line fails a release commit that carries a fragment, and passes the release and an ordinary change', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/changes.mjs'), await readFile(script, 'utf8'));
  const local = () => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--check', '--base', base.trim()], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'changes/normal.md'), fragment('repo', 'fix', 'Normal.'));
  assert.equal(local().status, 0, local().stderr);
  await bump(root, '0.1.0-beta.14');
  const fail = local();
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /release commit carries unfolded fragments: normal\.md; refold on current main/);
  await rm(join(root, 'changes/normal.md'));
  const pass = local();
  assert.equal(pass.status, 0, pass.stderr);
}));
