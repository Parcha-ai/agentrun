import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bulletOf, fold, hasVersionSection, loadFragments, movedPython, ownVersionPackages, parseFragment, previousRelease, releaseCommit, sectionDate, stalePython, staleOwnVersions, unreleasedEdits, unreleasedSection } from './changes.mjs';

const exec = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), 'changes.mjs');
/** changes.mjs and the module it decides it is the command with, into the fixture repository's scripts/. */
const copyScript = async (root) => {
  for (const name of ['changes.mjs', 'is-main.mjs']) await writeFile(join(root, 'scripts', name), await readFile(join(dirname(script), name), 'utf8'));
};
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

// A release's tag carries the fragments of pull requests that merged after its release pull request's fold. The release workflow folds
// them at the tag into the archives; the next release's fold puts them into that release's section on main.
const sectionOf = (text, version) => text.slice(text.indexOf(`## ${version}`)).split(/\n(?=## )/)[0];
const emptyVision = '# Changelog\n\n## Unreleased\n';
/** Release 0.1.0-beta.13 folded on main, then two pull requests that merged before its tag: the tag carries their fragments. */
async function taggedWithLateFragments(root, git) {
  await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), emptyVision);
  await writeFile(join(root, 'changes/early.md'), fragment('repo', 'feature', 'Early.'));
  await commitAll(git, 'main before the release');
  await fold(root, '0.1.0-beta.13', '2026-10-20');
  await commitAll(git, 'the release pull request');
  await writeFile(join(root, 'changes/a-late.md'), fragment('repo, @parcha/pi-vision', 'fix', 'Late.'));
  await writeFile(join(root, 'changes/b-late-vision.md'), fragment('@parcha/pi-vision', 'fix', 'Late vision.'));
  await commitAll(git, 'two pull requests the queue merged before the tag');
  await git('tag', 'v0.1.0-beta.13');
}

test("the release workflow's fold at the tag puts what the tag carries into the tag's version, and the next release's fold writes that same section on main", () => repo(async (root, git) => {
  await taggedWithLateFragments(root, git);
  // At the tag, as release.yml runs it: the version's date is the root section's, and every fragment there is this release's.
  assert.equal(sectionDate(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), '0.1.0-beta.13'), '2026-10-20');
  const atTag = await fold(root, '0.1.0-beta.13', '2026-10-20');
  assert.deepEqual([atTag.folded, atTag.shipped], [2, []]);
  const published = {};
  for (const file of ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']) published[file] = sectionOf(await readFile(join(root, file), 'utf8'), '0.1.0-beta.13');
  assert.equal(published['CHANGELOG.md'], '## 0.1.0-beta.13 (2026-10-20)\n\n- Existing root bullet.\n- Early.\n- Late.\n');
  assert.equal(published['packages/pi-vision/CHANGELOG.md'], '## 0.1.0-beta.13 (2026-10-20)\n\n- Late.\n- Late vision.\n');
  // The workflow does not commit: main still holds the two fragments. The next pull requests and the next release's fold.
  await git('checkout', '-q', 'HEAD', '--', '.');
  await writeFile(join(root, 'changes/next.md'), fragment('repo, @parcha/pi-vision', 'feature', 'Next.'));
  await commitAll(git, 'a pull request after the tag');
  const { stdout: base } = await git('rev-parse', 'HEAD');
  const next = await fold(root, '0.1.0-beta.14', '2026-10-25');
  assert.deepEqual([next.folded, next.shipped, next.previous], [3, ['a-late.md', 'b-late-vision.md'], '0.1.0-beta.13']);
  assert.deepEqual(await loadFragments(root), []);
  for (const file of Object.keys(published)) assert.equal(sectionOf(await readFile(join(root, file), 'utf8'), '0.1.0-beta.13'), published[file], `${file} says for 0.1.0-beta.13 what its archives said`);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.14 (2026-10-25)\n\n- Next.\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Existing root bullet.\n- Early.\n- Late.\n\n## 0.1.0-beta.12, 2026-10-09\n\n- Older.\n');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.14 (2026-10-25)\n\n- Next.\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Late.\n- Late vision.\n', 'the earlier section is made below the new one');
  assert.deepEqual((await unreleasedEdits(root, base.trim())).edited, [], 'the release pull request passes the check: no Unreleased section is edited');
}));

test("a late fragment's own section is made under the release's, never from what Unreleased holds, and the next fold dates both", () => repo(async (root, git) => {
  await taggedWithLateFragments(root, git);
  // pi-vision was held at the tag and is published now: its Unreleased entry is the next release's, not the earlier one's.
  await writeFile(join(root, 'packages/pi-vision/CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Held until now.\n');
  await commitAll(git, 'an entry pi-vision kept while held');
  await fold(root, '0.1.0-beta.14', '2026-10-25');
  assert.equal(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.14 (2026-10-25)\n\n- Held until now.\n\n## 0.1.0-beta.13 (2026-10-20)\n\n- Late.\n- Late vision.\n');
}));

test("a held package's late fragment joins its Unreleased in the fold's order with the rest, and passes the check", () => repo(async (root, git) => {
  await heldPackage(root, heldLog);
  await taggedWithLateFragments(root, git);
  await writeFile(join(root, 'changes/a-held-late.md'), fragment('@parcha/pi-transport', 'fix', 'Held late.'));
  await commitAll(git, 'a held fragment that merged before the tag');
  await git('tag', '-d', 'v0.1.0-beta.13');
  await git('tag', 'v0.1.0-beta.13');
  await writeFile(join(root, 'changes/z-held-next.md'), fragment('@parcha/pi-transport', 'breaking', 'Held next.'));
  await commitAll(git, 'a held fragment after the tag');
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await fold(root, '0.1.0-beta.14', '2026-10-25');
  assert.equal(await readFile(join(root, heldPath), 'utf8'), `${heldLog}- Held next.\n- Held late.\n`, 'breaking before fix, one run');
  assert.deepEqual(await unreleasedEdits(root, base.trim()), { fold: true, edited: [] });
}));

test('a fragment is the earlier release\'s only when its tag carried that exact file: a reused name with new text is the new release\'s', () => repo(async (root, git) => {
  await taggedWithLateFragments(root, git);
  await writeFile(join(root, 'changes/b-late-vision.md'), fragment('@parcha/pi-vision', 'fix', 'Reworded after the tag.'));
  await commitAll(git, 'a fragment changed after the tag');
  const previous = await previousRelease(root, '0.1.0-beta.14');
  assert.deepEqual([previous.tag, previous.version, [...previous.carried.keys()]], ['v0.1.0-beta.13', '0.1.0-beta.13', ['a-late.md', 'b-late-vision.md']]);
  assert.equal(await previousRelease(root, '0.1.0-beta.13'), null, 'the tag being folded is never its own previous release');
  const result = await fold(root, '0.1.0-beta.14', '2026-10-25');
  assert.deepEqual(result.shipped, ['a-late.md']);
  assert.match(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), /## 0\.1\.0-beta\.14 \(2026-10-25\)\n\n- Reworded after the tag\.\n\n## 0\.1\.0-beta\.13 \(2026-10-20\)\n\n- Late\.\n$/);
}));

test('a late fragment whose release has no dated section in the root changelog is refused, and nothing is written', () => repo(async (root, git) => {
  await taggedWithLateFragments(root, git);
  await writeFile(join(root, 'CHANGELOG.md'), rootLog);
  await commitAll(git, 'the root changelog lost the section');
  await assert.rejects(fold(root, '0.1.0-beta.14', '2026-10-25'), /CHANGELOG\.md has no dated section for 0\.1\.0-beta\.13, whose tag v0\.1\.0-beta\.13 carried a-late\.md, b-late-vision\.md/);
  assert.equal((await loadFragments(root)).length, 2);
}));

test('a fold given the previous release (as the preflight refolds a tag outside the repository) places its fragments as the repository\'s fold does', () => repo(async (root, git) => {
  await taggedWithLateFragments(root, git);
  await writeFile(join(root, 'changes/next.md'), fragment('repo', 'feature', 'Next.'));
  await commitAll(git, 'a pull request after the tag');
  const previous = await previousRelease(root, '0.1.0-beta.14');
  await repo(async elsewhere => {
    for (const path of ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md', 'changes/a-late.md', 'changes/b-late-vision.md', 'changes/next.md']) await writeFile(join(elsewhere, path), await readFile(join(root, path), 'utf8'));
    assert.deepEqual((await fold(elsewhere, '0.1.0-beta.14', '2026-10-25', { previous })).shipped, ['a-late.md', 'b-late-vision.md']);
    await fold(root, '0.1.0-beta.14', '2026-10-25');
    for (const path of ['CHANGELOG.md', 'packages/pi-vision/CHANGELOG.md']) assert.equal(await readFile(join(elsewhere, path), 'utf8'), await readFile(join(root, path), 'utf8'), path);
  });
}));

test('the command line folds at the date the root changelog already gives the version, else today', () => repo(async (root, git) => {
  await taggedWithLateFragments(root, git);
  await mkdir(join(root, 'scripts'));
  await copyScript(root);
  const run = spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--fold', '0.1.0-beta.13'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(await readFile(join(root, 'packages/pi-vision/CHANGELOG.md'), 'utf8'), /## 0\.1\.0-beta\.13 \(2026-10-20\)\n/);
  assert.equal(sectionDate('# Changelog\n\n## 0.1.0-beta.12, 2026-10-09\n', '0.1.0-beta.12'), '2026-10-09');
  assert.equal(sectionDate(rootLog, '0.1.0-beta.99'), undefined);
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
  await copyScript(root);
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

test('releaseCommit: a version bump is the release, with only the README in changes/ or beside a fragment the fold did not see', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await bump(root, '0.1.0-beta.14');
  assert.deepEqual(await releaseCommit(root, base.trim()), { release: true, bumped: ['dsl', 'pi-vision'] });
  await writeFile(join(root, 'changes/late.md'), fragment('repo', 'fix', 'Late.'));
  assert.deepEqual(await releaseCommit(root, base.trim()), { release: true, bumped: ['dsl', 'pi-vision'] }, 'a late fragment is the release workflow\'s to fold at the tag');
}));
test('releaseCommit: a pull request with fragments and no version change is not a release, also when it adds a package', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'changes/normal.md'), fragment('repo', 'fix', 'Normal.'));
  await mkdir(join(root, 'packages/new'));
  await writeFile(join(root, 'packages/new/package.json'), JSON.stringify({ name: '@parcha/new', version: '0.0.1' }));
  assert.deepEqual(await releaseCommit(root, base.trim()), { release: false, bumped: [] });
}));
// A package on its own version line: @parcha/agentrun, published at its manifest's version.
const ownPackage = async (root, git, version) => {
  await mkdir(join(root, 'packages/agentrun/lib'), { recursive: true });
  await mkdir(join(root, 'packages/agentrun/test'), { recursive: true });
  await writeFile(join(root, 'packages/agentrun/package.json'), JSON.stringify({ name: '@parcha/agentrun', version, files: ['bin', 'lib', 'README.md'] }));
  await writeFile(join(root, 'packages/agentrun/lib/start.mjs'), 'export const start = 1;\n');
  await writeFile(join(root, 'packages/agentrun/test/start.test.mjs'), 'export {};\n');
  await commitAll(git, 'the own-version package');
  return (await git('rev-parse', 'HEAD')).stdout.trim();
};
const setVersion = async (root, version) => {
  const path = join(root, 'packages/agentrun/package.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version }));
};

test('a package on its own version line: bumping it beside a fragment is an ordinary pull request, not a release', () => repo(async (root, git) => {
  assert.deepEqual(ownVersionPackages, ['agentrun']);
  await withVersion(root, git);
  const base = await ownPackage(root, git, '0.3.0');
  await writeFile(join(root, 'changes/start.md'), fragment('repo', 'fix', 'Start.'));
  await writeFile(join(root, 'packages/agentrun/lib/start.mjs'), 'export const start = 2;\n');
  await setVersion(root, '0.3.1');
  assert.deepEqual(await releaseCommit(root, base), { release: false, bumped: [] });
  assert.deepEqual(await staleOwnVersions(root, base), []);
}));
test('a package on its own version line that changes a file it publishes and keeps its version is stale; its tests, a bump or a new package are not', () => repo(async (root, git) => {
  await withVersion(root, git);
  assert.deepEqual(await staleOwnVersions(root, (await git('rev-parse', 'HEAD')).stdout.trim()), [], 'a package the base does not have is new');
  const base = await ownPackage(root, git, '0.3.0');
  await writeFile(join(root, 'packages/agentrun/test/start.test.mjs'), 'export const more = 1;\n');
  assert.deepEqual(await staleOwnVersions(root, base), [], 'its tests are not published');
  await writeFile(join(root, 'packages/agentrun/README.md'), 'Start it.\n');
  await commitAll(git, 'a readme');
  assert.deepEqual(await staleOwnVersions(root, base), ['agentrun'], 'the README is published');
  await setVersion(root, '0.3.1');
  assert.deepEqual(await staleOwnVersions(root, base), []);
  await setVersion(root, '0.3.0');
  await writeFile(join(root, 'packages/agentrun/lib/start.mjs'), 'export const start = 2;\n');
  assert.deepEqual(await staleOwnVersions(root, base), ['agentrun']);
}));
test('the command line passes a release commit that carries a fragment (the merge queue put a pull request ahead of it), the release alone and an ordinary change', () => repo(async (root, git) => {
  await withVersion(root, git);
  const { stdout: base } = await git('rev-parse', 'HEAD');
  await mkdir(join(root, 'scripts'));
  await copyScript(root);
  const local = () => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--check', '--base', base.trim()], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'changes/normal.md'), fragment('repo', 'fix', 'Normal.'));
  assert.equal(local().status, 0, local().stderr);
  await bump(root, '0.1.0-beta.14');
  const beside = local();
  assert.equal(beside.status, 0, beside.stderr);
  await rm(join(root, 'changes/normal.md'));
  const pass = local();
  assert.equal(pass.status, 0, pass.stderr);
}));
test('a pull request that changes the files the command publishes keeps its version: the release sets it, and a pull request that moves it is refused', () => repo(async (root, git) => {
  await withVersion(root, git);
  const base = await ownPackage(root, git, '0.3.0');
  await mkdir(join(root, 'scripts'));
  await copyScript(root);
  const local = () => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--check', '--base', base], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'changes/start.md'), fragment('@parcha/agentrun', 'fix', 'Start.'));
  await writeFile(join(root, 'packages/agentrun/lib/start.mjs'), 'export const start = 2;\n');
  const pass = local();
  assert.equal(pass.status, 0, pass.stderr);
  await setVersion(root, '0.3.1');
  const fail = local();
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /packages\/agentrun moved its version from 0\.3\.0 to 0\.3\.1; the release sets it \(docs\/releasing\.md\), so a pull request leaves it at 0\.3\.0/);
}));
test('a release commit that changes the files the command publishes and keeps its version is refused; with its next version it passes', () => repo(async (root, git) => {
  await withVersion(root, git);
  const base = await ownPackage(root, git, '0.3.0');
  await mkdir(join(root, 'scripts'));
  await copyScript(root);
  const local = () => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--check', '--base', base], { cwd: root, encoding: 'utf8' });
  // The release: every workspace package bumped, and the command's pin on the server moved with them.
  await bump(root, '0.1.0-beta.14');
  await writeFile(join(root, 'packages/agentrun/lib/start.mjs'), 'export const start = 2;\n');
  const fail = local();
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /packages\/agentrun changed the files it publishes and kept its version; the release sets its next version in its package\.json/);
  await setVersion(root, '0.3.1');
  const pass = local();
  assert.equal(pass.status, 0, pass.stderr);
}));

// A package that came in behind the workspace version (added after a release bumped the rest) catches up in an ordinary pull
// request: it moves to the version the root package.json already holds at the merge base. A release moves the root too.
const setRoot = (root, version) => writeFile(join(root, 'package.json'), JSON.stringify({ name: 'workspace', private: true, version }));
const behind = async (root, git) => {
  await setRoot(root, '0.1.0-beta.13');
  await withVersion(root, git);
  const path = join(root, 'packages/pi-vision/package.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version: '0.1.0-beta.12' }));
  await commitAll(git, 'pi-vision came in behind the workspace');
  return (await git('rev-parse', 'HEAD')).stdout.trim();
};
test('releaseCommit: a package that moves to the workspace version the base already holds is catching up, not a release', () => repo(async (root, git) => {
  const base = await behind(root, git);
  await writeFile(join(root, 'changes/catch-up.md'), fragment('@parcha/pi-vision', 'fix', 'Catch up.'));
  const path = join(root, 'packages/pi-vision/package.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version: '0.1.0-beta.13' }));
  assert.deepEqual(await releaseCommit(root, base), { release: false, bumped: [] });
  // A move to any other version is still a bump.
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version: '0.1.0-beta.14' }));
  assert.deepEqual(await releaseCommit(root, base), { release: true, bumped: ['pi-vision'] });
}));
test('the command line passes a package catching up to the workspace version beside a fragment, and a release of every package with one', () => repo(async (root, git) => {
  const base = await behind(root, git);
  await mkdir(join(root, 'scripts'));
  await copyScript(root);
  const local = () => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--check', '--base', base], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'changes/catch-up.md'), fragment('@parcha/pi-vision', 'fix', 'Catch up.'));
  const path = join(root, 'packages/pi-vision/package.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version: '0.1.0-beta.13' }));
  const pass = local();
  assert.equal(pass.status, 0, pass.stderr);
  // The release: the root and every package at the next version, with the fragment unfolded (the release workflow folds it at the tag).
  await setRoot(root, '0.1.0-beta.14');
  await bump(root, '0.1.0-beta.14');
  assert.deepEqual(await releaseCommit(root, base), { release: true, bumped: ['dsl', 'pi-vision'] });
  const release = local();
  assert.equal(release.status, 0, release.stderr);
}));

// The Python client, parcha-agentrun: python/pyproject.toml's version is a line of its own, as @parcha/agentrun's is.
const pythonClient = async (root, git, version) => {
  await mkdir(join(root, 'python/agentrun'), { recursive: true });
  await mkdir(join(root, 'python/tests'), { recursive: true });
  await writeFile(join(root, 'python/pyproject.toml'), `[project]\nname = "parcha-agentrun"\nversion = "${version}"\n`);
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 1\n');
  await writeFile(join(root, 'python/tests/test_rules.py'), 'MORE = 1\n');
  await commitAll(git, 'the Python client');
  return (await git('rev-parse', 'HEAD')).stdout.trim();
};
const setPythonVersion = async (root, version) => {
  const path = join(root, 'python/pyproject.toml');
  await writeFile(path, (await readFile(path, 'utf8')).replace(/^version = ".*"$/m, `version = "${version}"`));
};

test('the Python client that changes a file it publishes and keeps its version is stale; its tests, a bump or a new client are not', () => repo(async (root, git) => {
  await withVersion(root, git);
  assert.equal(await stalePython(root, (await git('rev-parse', 'HEAD')).stdout.trim()), false, 'a client the base does not have is new');
  const base = await pythonClient(root, git, '0.3.0');
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 2\n');
  assert.equal(await stalePython(root, base), false, 'with no release tag, nothing has been published to go stale');
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 1\n');
  await git('tag', 'v0.1.0-beta.13');
  await writeFile(join(root, 'python/tests/test_rules.py'), 'MORE = 2\n');
  assert.equal(await stalePython(root, base), false, 'its tests are not published');
  await writeFile(join(root, 'python/README.md'), 'Start it.\n');
  assert.equal(await stalePython(root, base), true, 'the README is published');
  await setPythonVersion(root, '0.3.1');
  assert.equal(await stalePython(root, base), false);
  await setPythonVersion(root, '0.3.0');
  await rm(join(root, 'python/README.md'));
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 2\n');
  assert.equal(await stalePython(root, base), true, 'so is the package');
}));

test('a pull request that moves the Python client\'s version is refused; one that starts its line from a pre-release is not', () => repo(async (root, git) => {
  await withVersion(root, git);
  const started = await pythonClient(root, git, '0.3.0a0');
  await setPythonVersion(root, '0.3.0');
  assert.equal(await movedPython(root, started), null, 'a base on a pre-release had no line yet');
  await commitAll(git, 'the line starts');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('tag', 'v0.1.0-beta.13');
  assert.equal(await movedPython(root, base), null);
  await setPythonVersion(root, '0.3.1');
  assert.deepEqual(await movedPython(root, base), { was: '0.3.0', now: '0.3.1' });
  await mkdir(join(root, 'scripts'));
  await copyScript(root);
  const local = () => spawnSync(process.execPath, [join(root, 'scripts/changes.mjs'), '--check', '--base', base], { cwd: root, encoding: 'utf8' });
  const fail = local();
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /python moved its version from 0\.3\.0 to 0\.3\.1; the release sets it \(docs\/releasing\.md\), so a pull request leaves it at 0\.3\.0/);
  await setPythonVersion(root, '0.3.0');
  // A release commit that changes what the client publishes and keeps its version is refused.
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 2\n');
  await bump(root, '0.1.0-beta.14');
  const stale = local();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /python changed the files it publishes and kept its version 0\.3\.0/);
  await setPythonVersion(root, '0.3.1');
  assert.equal(local().status, 0, local().stderr);
}));

test('a client change merged in an earlier pull request is still stale at the release that keeps its version: against the last release tag, not the release pull request\'s base', () => repo(async (root, git) => {
  await withVersion(root, git);
  await pythonClient(root, git, '0.3.0');
  await git('tag', 'v0.1.0-beta.13');
  // Pull request 1 changes the client and, as a pull request does, leaves its version; it merges.
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 2\n');
  await commitAll(git, 'pull request 1: the client changes');
  const merged = (await git('rev-parse', 'HEAD')).stdout.trim();
  // Pull request 2 is the release: its base is pull request 1's merge, and it bumps the workspace, not the client.
  await bump(root, '0.1.0-beta.14');
  assert.equal(await stalePython(root, merged), true, 'what the client publishes differs from the last release\'s, though not from this base');
  await setPythonVersion(root, '0.3.1');
  assert.equal(await stalePython(root, merged), false, 'bumped, it publishes');
  await setPythonVersion(root, '0.3.0');
  await writeFile(join(root, 'python/agentrun/_client.py'), 'START = 1\n');
  await commitAll(git, 'pull request 3: the change undone');
  assert.equal(await stalePython(root, merged), false, 'the same files as the last release: nothing new to publish');
}));
