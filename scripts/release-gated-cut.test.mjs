import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogGains, gatedCut, releaseOwn, verdict, versionMoves } from './release-gated-cut.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'release-gated-cut.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('the gated cut is the last "Gated cut:" line of the release pull request', () => {
  assert.equal(gatedCut(`Release.\n\nGated cut: ${A}\n`), A);
  assert.equal(gatedCut(`Gated cut: ${A}\r\nre-gated after the queue moved:\r\nGated cut: ${B}  \r\n`), B, 'a re-gate adds a line; the last counts');
  assert.throws(() => gatedCut('Release, no gate yet.'), /no "Gated cut: <40-hex sha>" line/);
  assert.throws(() => gatedCut(null), /no "Gated cut: <40-hex sha>" line/, 'an empty body');
  assert.throws(() => gatedCut(`Gated cut: ${A.slice(0, 10)}`), /no "Gated cut: <40-hex sha>" line/, 'a short sha names nothing');
  assert.throws(() => gatedCut(`see Gated cut: ${A}`), /no "Gated cut: <40-hex sha>" line/, 'only a line of its own');
  assert.throws(() => gatedCut(`Gated cut: ${A.toUpperCase()}`), /no "Gated cut: <40-hex sha>" line/, 'as git prints it');
});

const change = (path, status, before, after, modes = ['100644', '100644']) => ({ path, status, before, after, modes });
const pkg = (version, deps = {}) => `${JSON.stringify({ name: 'x', version, dependencies: deps }, null, 2)}\n`;

test('the version moves come from the version fields a release changed', () => {
  const moves = versionMoves([
    change('package.json', 'M', pkg('0.1.0-beta.67'), pkg('0.1.0-beta.68')),
    change('packages/serve/package.json', 'M', pkg('0.1.0-beta.67'), pkg('0.1.0-beta.68')),
    change('packages/agentrun/package.json', 'M', pkg('0.4.35'), pkg('0.4.36')),
    change('python/pyproject.toml', 'M', '[project]\nversion = "0.3.34"\n', '[project]\nversion = "0.3.35"\n'),
    change('packages/web/package.json', 'M', pkg('0.1.0-beta.68', { a: '1' }), pkg('0.1.0-beta.68', { a: '2' })),
  ]);
  assert.deepEqual(moves, [['0.1.0-beta.67', '0.1.0-beta.68'], ['0.4.35', '0.4.36'], ['0.3.34', '0.3.35']]);
});

test("a release's own files: version lines moved by its versions, changelogs that only gain lines, fragments deleted", () => {
  const moves = [['0.1.0-beta.67', '0.1.0-beta.68'], ['0.4.35', '0.4.36']];
  const own = c => releaseOwn(c, moves);
  assert.equal(own(change('packages/serve/package.json', 'M', pkg('0.1.0-beta.67', { '@parcha/agentrun-dsl': '0.1.0-beta.67' }), pkg('0.1.0-beta.68', { '@parcha/agentrun-dsl': '0.1.0-beta.68' }))), true);
  assert.equal(own(change('deploy/fly/fly.toml', 'M', 'image = "ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.67"\n', 'image = "ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.68"\n')), true);
  assert.equal(own(change('render.yaml', 'M', 'url: x:v0.1.0-beta.67\n', 'url: x:v0.1.0-beta.68\n')), true);
  assert.equal(own(change('python/agentrun/__init__.py', 'M', '__version__ = "0.4.35"\n', '__version__ = "0.4.36"\n')), true);
  assert.equal(own(change('CHANGELOG.md', 'M', '# Changelog\n\n## Unreleased\n', '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.68 (2026-11-28)\n\n- A fix.\n')), true);
  assert.equal(own(change('packages/run-adapters/CHANGELOG.md', 'A', undefined, '# Changelog\n\n## 0.1.0-beta.68\n')), true, 'the fold may open a package changelog');
  assert.equal(own(change('changes/a-fix.md', 'D', '---\n---\nA fix.\n', undefined)), true);

  assert.equal(own(change('packages/serve/package.json', 'M', pkg('0.1.0-beta.68', { undici: '^8.12.3' }), pkg('0.1.0-beta.68', { undici: '^8.14.0' }))), false, 'a range of its own is not the release version');
  assert.equal(own(change('packages/serve/package.json', 'M', pkg('0.1.0-beta.68'), pkg('0.1.0-beta.68', { a: '1' }))), false, 'a line added');
  assert.equal(own(change('package.json', 'M', pkg('0.1.0-beta.67'), pkg('0.1.0-beta.68'), ['100644', '100755'])), false, 'a mode change');
  assert.equal(own(change('packages/serve/src/version.ts', 'M', "export const v = '0.1.0-beta.67';\n", "export const v = '0.1.0-beta.68';\n")), false, 'not a version file, whatever its line says');
  assert.equal(own(change('scripts/upstream-attribution.mjs', 'M', 'a\n', 'a\nb\n')), false, "a fix in the release's own pull request is gated by gating that pull request's head");
  assert.equal(own(change('CHANGELOG.md', 'M', '## 0.1.0-beta.67\n\n- Old words.\n', '## 0.1.0-beta.67\n\n- New words.\n')), false, 'a changelog line rewritten');
  assert.equal(own(change('changes/late.md', 'A', undefined, '---\n---\nLate.\n')), false, 'a fragment added');
  assert.equal(own(change('changes/README.md', 'D', 'x\n', undefined)), false);
  assert.equal(own(change('deploy/fly/fly.toml', 'D', 'x\n', undefined)), false);
});

test('a changelog only gains lines when every line it had is still there, in order', () => {
  assert.equal(changelogGains('a\nb\nc\n', 'a\nx\nb\ny\nc\n'), true);
  assert.equal(changelogGains('a\nb\n', 'b\na\n'), false);
  assert.equal(changelogGains('a\nb\n', 'a\n'), false);
});

test('the verdict: the same tree passes, the release\'s own files pass, anything else is refused naming files and commits', () => {
  const base = { cut: A, tag: B, cutTree: 'c'.repeat(40), fragments: [], commits: [] };
  assert.deepEqual(verdict({ ...base, tagTree: 'c'.repeat(40), changes: [] }).pass, true);
  const own = verdict({ ...base, tagTree: 'd'.repeat(40), changes: [change('changes/a.md', 'D', 'x\n', undefined)] });
  assert.equal(own.pass, true);
  assert.match(own.say, /only in the release's own files/);
  const slipped = verdict({ ...base, tagTree: 'd'.repeat(40), changes: [change('packages/computer/src/e2b.ts', 'M', 'a\n', 'b\n')], commits: ['ed0942bf7a fix(computer): a REST retry'] });
  assert.equal(slipped.pass, false);
  assert.match(slipped.say, /tree dddddddddd/);
  assert.match(slipped.say, /tree cccccccccc/);
  assert.match(slipped.say, /packages\/computer\/src\/e2b\.ts/);
  assert.match(slipped.say, /1 commit the gate never saw:\n  ed0942bf7a fix\(computer\): a REST retry/);
  const unfolded = verdict({ ...base, tagTree: 'c'.repeat(40), changes: [], fragments: ['changes/late.md'] });
  assert.equal(unfolded.pass, true, 'a fragment in the gated tree was gated; the publish job folds it into the release');
  assert.match(unfolded.say, /1 changes\/ fragment at the tag, unfolded, which the publish job folds into the release: changes\/late\.md/);
});

// A throwaway repository: one main, and a release branch cut from it.
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gated-cut-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // CI's own GitHub settings stay out: the child would ask GitHub about this repository's commits, or write CI's summary.
  const { GITHUB_REPOSITORY, GH_TOKEN, GITHUB_TOKEN, GITHUB_STEP_SUMMARY, ...outside } = process.env;
  const env = { ...outside, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'r', GIT_AUTHOR_EMAIL: 'r@example.invalid', GIT_COMMITTER_NAME: 'r', GIT_COMMITTER_EMAIL: 'r@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = (message, files, removed = []) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    for (const path of removed) git('rm', '-q', path);
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  commit('start', { 'package.json': pkg('0.1.0-beta.67'), 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n', 'src/a.js': 'a\n', 'changes/README.md': 'fragments\n', 'changes/fix.md': '---\n---\nA fix.\n' });
  return { dir, git, commit, run };
}

// The release pull request's head: the bump and the fold, cut from main.
function cutRelease({ git, commit }) {
  git('switch', '-q', '-c', 'release');
  const head = commit('release: 0.1.0-beta.68', { 'package.json': pkg('0.1.0-beta.68'), 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.68 (2026-11-28)\n\n- A fix. <!-- changes/fix.md -->\n' }, ['changes/fix.md']);
  git('switch', '-q', 'main');
  return head;
}

// The merge queue's squash of the release pull request onto main as main is then, and the tag on it.
function squash({ git }, head) {
  git('merge', '-q', '--squash', head);
  git('commit', '-qm', 'release: 0.1.0-beta.68 (#1)');
  git('tag', 'v0.1.0-beta.68');
  return git('rev-parse', 'HEAD');
}

test("beta.68's shape: post-cut pull requests squashed under the release commit are refused, by name", t => {
  const repo = repository(t);
  const cut = cutRelease(repo);
  repo.commit('feat: a provider (#2)', { 'src/b.js': 'b\n', 'changes/provider.md': '---\n---\nA provider.\n' });
  repo.commit('fix: a retry (#3)', { 'src/a.js': 'a, retried\n' });
  squash(repo, cut);
  const out = repo.run('--tag', 'v0.1.0-beta.68', '--cut', cut);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /2 commits the gate never saw:\n {2}[0-9a-f]{10} fix: a retry \(#3\)\n {2}[0-9a-f]{10} feat: a provider \(#2\)/);
  assert.match(out.stderr, /src\/a\.js/);
  assert.match(out.stderr, /changes\/provider\.md/, 'its fragment is at the tag, unfolded');
});

test('a clean release passes: the squash onto an unmoved main is the gated tree', t => {
  const repo = repository(t);
  const cut = cutRelease(repo);
  squash(repo, cut);
  const out = repo.run('--tag', 'v0.1.0-beta.68', '--cut', cut);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /the tree the gate ran on/);
});

test("a gate on main before the bump passes when the tag adds only the release's own files", t => {
  const repo = repository(t);
  const before = repo.git('rev-parse', 'HEAD');
  squash(repo, cutRelease(repo));
  const out = repo.run('--tag', 'v0.1.0-beta.68', '--cut', before);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /only in the release's own files/);
});

test("a re-gate of the merge commit itself passes, its late fragments named for the publish job's fold", t => {
  const repo = repository(t);
  const cut = cutRelease(repo);
  repo.commit('feat: a provider (#2)', { 'src/b.js': 'b\n', 'changes/provider.md': '---\n---\nA provider.\n' });
  const tag = squash(repo, cut);
  const out = repo.run('--tag', 'v0.1.0-beta.68', '--cut', tag);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /are the same\.\n1 changes\/ fragment at the tag, unfolded, which the publish job folds into the release: changes\/provider\.md/);
});

test('without a cut or a repository to ask, it stops and says what it needs', t => {
  const repo = repository(t);
  squash(repo, cutRelease(repo));
  const out = repo.run('--tag', 'v0.1.0-beta.68');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /GITHUB_REPOSITORY/);
});
