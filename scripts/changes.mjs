#!/usr/bin/env node
// Changelog fragments: one file per pull request in changes/, folded into the CHANGELOGs by the release. Nothing but the release
// edits an Unreleased section, so two pull requests never touch the same lines.
//   node scripts/changes.mjs --check [--base <commit>]   validate fragments; fail an edit of any Unreleased section
//   node scripts/changes.mjs --fold <version> [--date YYYY-MM-DD]   move each fragment into the CHANGELOG its package names
// The release pull request folds what main holds then; the release workflow folds what its tag still carries (fragments of pull
// requests that merged after that fold) into the archives it publishes, uncommitted, and the next release's fold puts those into
// that release's section on main. A release never waits for, or refolds after, a pull request that merges beside it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isMain } from './is-main.mjs';

const exec = promisify(execFile);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const kinds = ['breaking', 'feature', 'fix', 'ci', 'docs'];
// The packages on a version line of their own, published at their manifest's version and not the workspace's: @parcha/agentrun (the
// `npx @parcha/agentrun` command) starts at 0.3.0, above the hosted-API SDK's 0.2.x that the same npm name published from another
// repository. The release sets its version, and every release moves it: its manifest pins the server at the release's version.
// `--check` refuses a pull request that moves it, and a release commit that changes a file it ships and keeps it (a release that
// finds the version published with other bytes stops). Bumping it alone is not a release commit.
export const ownVersionPackages = ['agentrun'];
const fragmentName = /^[a-z0-9][a-z0-9-]*\.md$/;

/** The workspace package names (`@parcha/...`) by directory, read from the manifests under `root`. */
export async function workspacePackages(root) {
  const packages = new Map();
  for (const directory of await readdir(join(root, 'packages'))) {
    try { packages.set(directory, JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8')).name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return packages;
}

/** `{ packages, kind, body }` from a fragment's text; throws a message naming `name` when the shape is wrong. */
export function parseFragment(raw, name, known) {
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${name}: starts with a front matter block (--- ... ---)`);
  const fields = Object.fromEntries(match[1].split('\n').filter(line => line.trim()).map(line => {
    const at = line.indexOf(':');
    assert.ok(at > 0, `${name}: front matter line "${line}" is not "key: value"`);
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  assert.deepEqual(Object.keys(fields).filter(key => !['packages', 'kind'].includes(key)), [], `${name}: front matter has only packages and kind`);
  const packages = (fields.packages ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  assert.ok(packages.length > 0, `${name}: packages names at least one package, or repo`);
  for (const entry of packages) assert.ok(entry === 'repo' || known.has(entry), `${name}: "${entry}" is not repo or a workspace package (${[...known].join(', ')})`);
  assert.ok(kinds.includes(fields.kind), `${name}: kind is one of ${kinds.join(', ')}`);
  const body = match[2].trim();
  assert.ok(body.length > 0, `${name}: the change text is empty`);
  assert.ok(!/^[-*]\s/.test(body), `${name}: write the text without the leading bullet; the fold adds it`);
  return { packages: [...new Set(packages)], kind: fields.kind, body };
}

/** Every fragment under changes/, sorted by name. The directory's README is not one. */
export async function loadFragments(root = defaultRoot) {
  const known = new Set((await workspacePackages(root)).values());
  let names;
  try { names = await readdir(join(root, 'changes')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const fragments = [];
  for (const file of names.filter(entry => entry !== 'README.md').sort()) {
    assert.match(file, fragmentName, `changes/${file}: a fragment is <slug>.md, the slug lowercase letters, digits and dashes; nothing else belongs in changes/`);
    const text = await readFile(join(root, 'changes', file), 'utf8');
    fragments.push({ file, text, ...parseFragment(text, `changes/${file}`, known) });
  }
  return fragments;
}

/** The lines of the Unreleased section of a changelog's text, heading included; '' when it has none. */
export function unreleasedSection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^## \[?Unreleased\]?\s*$/i.test(line));
  if (start < 0) return '';
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

/** Every changelog path a fold may write, root first, whether or not the file exists. */
export const changelogPaths = async root => ['CHANGELOG.md', ...[...(await workspacePackages(root)).keys()].sort().map(directory => `packages/${directory}/CHANGELOG.md`)];
const git = async (root, args) => (await exec('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
const gitShow = async (root, commit, path) => { try { return await git(root, ['show', `${commit}:${path}`]); } catch { return null; } };
const readOptional = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** The changelog the bullet of a fragment naming the package `name` goes to: that package's own, else the root. */
async function changelogFor(root, directories, name) {
  const directory = [...directories].find(([, packageName]) => packageName === name)?.[0];
  return directory && await readOptional(join(root, 'packages', directory, 'CHANGELOG.md')) !== null ? `packages/${directory}/CHANGELOG.md` : 'CHANGELOG.md';
}

/** Whether the changelog at `file` (under `root`) belongs to a held package: its manifest says `"private": true`, the reading release-preflight uses. */
async function heldChangelog(root, file) {
  if (file === 'CHANGELOG.md') return false;
  const manifest = await readOptional(join(root, dirname(file), 'package.json'));
  return manifest !== null && JSON.parse(manifest).private === true;
}

/** Appends `bullets` to the Unreleased section of `lines`, in place, after the section's own entries: what the fold does to a held package's changelog. */
function appendToUnreleased(lines, bullets) {
  const unreleased = lines.findIndex(unreleasedHeading);
  const keeps = lines.slice(unreleased + 1, sectionEnd(lines, unreleased)).some(line => line.trim());
  lines.splice(sectionEnd(lines, unreleased), 0, ...(keeps ? [] : ['']), ...bullets);
}

/** The fragments that were in changes/ at `mergeBase` and are gone from the working tree: the ones a fold deleted. */
async function removedFragments(root, mergeBase, known) {
  const listed = (await git(root, ['ls-tree', '--name-only', mergeBase, 'changes/'])).split('\n').map(line => line.replace(/^changes\//, '')).filter(name => name.endsWith('.md') && name !== 'README.md');
  const removed = [];
  for (const file of listed.sort()) {
    if (await readOptional(join(root, 'changes', file)) !== null) continue;
    const text = await gitShow(root, mergeBase, `changes/${file}`);
    removed.push({ file, ...parseFragment(text, `changes/${file}`, known) });
  }
  return removed;
}

/**
 * Whether the held package's changelog at `path` changed only by the fold: its Unreleased section is exactly what `was` becomes when
 * the bullets of the fragments this change deleted, which name that package, are appended in the fold's order. Any other change to
 * it is an edit.
 */
async function foldedIntoHeld(root, path, was, is, removed, directories) {
  if (!await heldChangelog(root, path) || !(was ?? '').split('\n').some(unreleasedHeading)) return false;
  const bullets = [];
  for (const fragment of [...removed].sort(foldOrder)) {
    const files = await Promise.all(fragment.packages.map(name => changelogFor(root, directories, name)));
    if (files.includes(path)) bullets.push(bulletOf(fragment.body));
  }
  if (bullets.length === 0) return false;
  return heldSection(was, bullets) === unreleasedSection(is ?? '');
}

/** The Unreleased section a held changelog has when `bullets` are appended to `was`'s, as the fold writes it. */
function heldSection(was, bullets) {
  const lines = was.split('\n');
  appendToUnreleased(lines, bullets);
  while (lines.at(-1) === '') lines.pop();
  return unreleasedSection(`${lines.join('\n')}\n`);
}

/**
 * The changelogs whose Unreleased section differs from `base`'s. An edit that leaves the section empty is the release's fold
 * (it moved the bullets into the version's section), whatever else the change or its merge group adds. So is a held package's changelog whose
 * Unreleased section is exactly its old text with the fragments the change deleted appended; any other edit is refused.
 */
export async function unreleasedEdits(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const directories = await workspacePackages(root);
  let removed = null;
  const edited = [];
  let emptied = 0;
  for (const path of await changelogPaths(root)) {
    const was = await gitShow(root, mergeBase, path);
    const is = await readOptional(join(root, path));
    if (unreleasedSection(was ?? '') === unreleasedSection(is ?? '')) continue;
    if (unreleasedSection(is ?? '').split('\n').slice(1).every(line => !line.trim())) emptied++;
    else if (await foldedIntoHeld(root, path, was, is, removed ??= await removedFragments(root, mergeBase, new Set(directories.values())), directories)) emptied++;
    else edited.push(path);
  }
  return { fold: edited.length === 0 && emptied > 0, edited };
}

/** The bullet a fragment becomes: its first line behind "- ", the rest indented under it. */
export const bulletOf = body => body.split('\n').map((line, index) => (index === 0 ? `- ${line}` : line.trim() ? `  ${line}` : '')).join('\n');

/** Whether `line` is the heading of `version`'s section: "## 0.1.0-beta.13, 2026-10-20", "## 0.1.0-beta.13" or "## [0.1.0-beta.13] ...". */
const isVersionHeading = (line, version) => line.startsWith('## ') && line.slice(3).replace(/^\[/, '').split(/[\],\s]/)[0] === version;

const kindOrder = fragment => kinds.indexOf(fragment.kind);
/** The order the fold writes fragments in: by kind, then by file name. */
const foldOrder = (a, b) => kindOrder(a) - kindOrder(b) || a.file.localeCompare(b.file);

const unreleasedHeading = line => /^## \[?Unreleased\]?\s*$/i.test(line);
const sectionEnd = (lines, heading) => {
  let end = lines.findIndex((line, index) => index > heading && /^## /.test(line));
  if (end < 0) end = lines.length;
  while (end > heading + 1 && lines[end - 1].trim() === '') end--;
  return end;
};

/** What one fold does to a published changelog with no section for `version` yet, in place: `bullets` join the Unreleased section's
 *  own entries, the section is renamed `## <version> (<date>)`, and an empty Unreleased opens above it. */
function datedSection(lines, version, date, bullets) {
  const unreleased = lines.findIndex(unreleasedHeading);
  const held = lines.slice(unreleased + 1, sectionEnd(lines, unreleased)).some(line => line.trim());
  lines.splice(sectionEnd(lines, unreleased), 0, ...(held ? [] : ['']), ...bullets);
  const heading = lines[unreleased];
  lines.splice(unreleased, 1, heading, '', `## ${version} (${date})`);
}

/** The date in the heading of `version`'s section ("## 0.1.0-beta.13 (2026-10-20)" or "## 0.1.0-beta.13, 2026-10-20"), or undefined. */
export function sectionDate(text, version) {
  const line = text.split('\n').find(entry => isVersionHeading(entry, version));
  return line === undefined ? undefined : /(\d{4}-\d{2}-\d{2})\)?\s*$/.exec(line)?.[1];
}

/**
 * The release before `version`: the newest `v*` tag reachable from HEAD other than `v<version>`, its version, and what changes/ held
 * at it (file name to text). The release workflow folds every fragment its tag carries into the archives it publishes, so a fragment
 * still in changes/ with that text shipped in that release. Null when there is no such tag (or no repository).
 */
export async function previousRelease(root, version) {
  let tag;
  try { tag = (await git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', `v${version}`, 'HEAD'])).trim(); } catch { return null; }
  if (!tag) return null;
  const carried = new Map();
  for (const path of (await git(root, ['ls-tree', '--name-only', tag, 'changes/'])).split('\n')) {
    const file = path.replace(/^changes\//, '');
    if (fragmentName.test(file)) carried.set(file, await gitShow(root, tag, path));
  }
  return { tag, version: tag.slice(1), carried };
}

/** Whether `fragment` shipped in `previous` (`previousRelease`): its tag carried this exact file, so that release's fold took it. */
const shippedIn = (previous, fragment) => previous !== null && previous.carried.get(fragment.file) === fragment.text;

/**
 * Puts `bullets` into the published changelog `lines`, in place, under `version`'s section: at its end when it has one, else in a new
 * section `## <version> (<date>)` right below the Unreleased section and below `newer`'s section when that follows it. Never takes
 * what Unreleased holds: that belongs to the release being folded.
 */
function addToSection(lines, version, date, bullets, newer) {
  const existing = lines.findIndex(line => isVersionHeading(line, version));
  if (existing >= 0) { lines.splice(sectionEnd(lines, existing), 0, ...bullets); return; }
  const unreleased = lines.findIndex(unreleasedHeading);
  assert.ok(unreleased >= 0, `the changelog has no Unreleased heading to put ${version}'s section under`);
  const next = from => { const at = lines.findIndex((line, index) => index > from && /^## /.test(line)); return at < 0 ? lines.length : at; };
  let at = next(unreleased);
  if (at < lines.length && isVersionHeading(lines[at], newer)) at = next(at);
  lines.splice(at, 0, ...(lines[at - 1] === '' ? [] : ['']), `## ${version} (${date})`, '', ...bullets, '');
}

/**
 * Folds the release into the changelogs. Every changelog is visited: one whose Unreleased section holds bullets or that gets
 * fragments has that section renamed `## <version> (<date>)`, with the fragments' bullets after its own, and a new empty
 * Unreleased section opened above it. The root changelog is dated also when it holds nothing and the release has fragments. A
 * fragment goes to its package's own changelog, else the root. A changelog with neither held bullets nor fragments is untouched;
 * one that already has the version's section gets the fragments' bullets appended to it. A held package (its manifest says
 * `"private": true`) ships nothing in this release, so its changelog is never dated: its fragments' bullets are appended to its
 * Unreleased section, which keeps its name and its entries.
 *
 * A fragment that the previous release's tag carried (`previousRelease`) shipped in that release: the release workflow folded it into
 * the archives at the tag, after the release pull request's fold. Its bullet goes into that release's section, under that release's
 * date from the root changelog, and never into this one, so main's changelogs end up saying what each release published. A held
 * package's changelog has no sections: those bullets join its Unreleased in the fold's order with the rest. `options.previous` gives
 * that release (`previousRelease`'s shape, or null) for a `root` that is not the repository, as release-preflight's refold of a tag is.
 */
export async function fold(root, version, date, options = {}) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, 'The version is like 0.1.0-beta.13');
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, 'The date is YYYY-MM-DD');
  const directories = await workspacePackages(root);
  const fragments = await loadFragments(root);
  const previous = 'previous' in options ? options.previous : await previousRelease(root, version);
  const shipped = fragments.filter(fragment => shippedIn(previous, fragment));
  let previousDate;
  if (shipped.length) {
    previousDate = sectionDate(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), previous.version);
    assert.ok(previousDate, `CHANGELOG.md has no dated section for ${previous.version}, whose tag ${previous.tag} carried ${shipped.map(fragment => fragment.file).join(', ')}`);
  }
  const current = fragments.length - shipped.length;
  // Every changelog that exists is visited, so a package changelog that holds bullets and gets no fragment is dated too.
  const targets = new Map([['CHANGELOG.md', { now: [], before: [] }]]);
  for (const file of await changelogPaths(root)) if (file !== 'CHANGELOG.md' && await readOptional(join(root, file)) !== null) targets.set(file, { now: [], before: [] });
  for (const fragment of [...fragments].sort(foldOrder)) {
    const files = new Set();
    for (const name of fragment.packages) files.add(await changelogFor(root, directories, name));
    for (const file of files) targets.get(file)[shipped.includes(fragment) ? 'before' : 'now'].push(fragment);
  }
  // Every new text is built before anything is written, and a failed write puts the changelogs and fragments back, so a retry
  // never appends a bullet twice.
  const writes = [];
  for (const [file, { now, before }] of targets) {
    let bullets = now.map(fragment => bulletOf(fragment.body));
    const original = await readFile(join(root, file), 'utf8');
    const lines = original.split('\n');
    const unreleased = lines.findIndex(unreleasedHeading);
    if (await heldChangelog(root, file)) {
      // A package this release does not publish gets no version section: its fragments join what its Unreleased section holds.
      if (now.length + before.length === 0) continue;
      assert.ok(unreleased >= 0, `${file} has no Unreleased heading to add to`);
      appendToUnreleased(lines, [...before, ...now].sort(foldOrder).map(fragment => bulletOf(fragment.body)));
    } else {
      let touched = false;
      if (before.length) { addToSection(lines, previous.version, previousDate, before.map(fragment => bulletOf(fragment.body)), version); touched = true; }
      const existing = lines.findIndex(line => isVersionHeading(line, version));
      const at = lines.findIndex(unreleasedHeading);
      if (existing >= 0) {
        if (bullets.length) { lines.splice(sectionEnd(lines, existing), 0, ...bullets); touched = true; }
      } else if (at >= 0 || bullets.length) {
        assert.ok(at >= 0, `${file} has no Unreleased heading to fold`);
        const held = lines.slice(at + 1, sectionEnd(lines, at)).some(line => line.trim());
        // The root always gets the version's section (the release preflight requires it), also when every change is a package's.
        if (file === 'CHANGELOG.md' && !held && bullets.length === 0 && current > 0) bullets = ['- Package changes only; see the package changelogs.'];
        if (held || bullets.length) { datedSection(lines, version, date, bullets); touched = true; }
      }
      if (!touched) continue;
    }
    while (lines.at(-1) === '') lines.pop();
    writes.push({ file, original, text: `${lines.join('\n')}\n` });
  }
  const written = [];
  const removed = [];
  try {
    for (const write of writes) { await writeFile(join(root, write.file), write.text); written.push(write); }
    for (const fragment of fragments) { await rm(join(root, 'changes', fragment.file)); removed.push(fragment); }
  } catch (error) {
    for (const write of written) await writeFile(join(root, write.file), write.original);
    for (const fragment of removed) await writeFile(join(root, 'changes', fragment.file), fragment.text);
    throw error;
  }
  const changed = writes.map(write => write.file);
  return { folded: fragments.length, files: changed, shipped: shipped.map(fragment => fragment.file), previous: shipped.length ? previous.version : null };
}

/** The workspace packages whose manifest version differs from the merge base's. A package the base does not have is new, not bumped,
 *  and one on its own version line (`ownVersionPackages`) is not a release's bump. Nor is one that moves to the workspace version the
 *  base already holds (the root package.json's, which release-preflight checks every package against): it came in behind and catches
 *  up. A release moves the workspace version too, so its packages move past the base's and are bumped. */
async function bumpedPackages(root, mergeBase) {
  const workspace = await gitShow(root, mergeBase, 'package.json');
  const workspaceVersion = workspace === null ? undefined : JSON.parse(workspace).version;
  const bumped = [];
  for (const directory of (await workspacePackages(root)).keys()) {
    if (ownVersionPackages.includes(directory)) continue;
    const was = await gitShow(root, mergeBase, `packages/${directory}/package.json`);
    if (was === null) continue;
    const is = JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8')).version;
    if (JSON.parse(was).version !== is && (workspaceVersion === undefined || is !== workspaceVersion)) bumped.push(directory);
  }
  return bumped;
}

/** Whether the tree is a release commit: a workspace package's version differs from the merge base's. A fragment beside one is not
 *  refused: it belongs to a pull request that merged after the release pull request's fold, and the release workflow folds it at the
 *  tag (see the top of this file). */
export async function releaseCommit(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const bumped = await bumpedPackages(root, mergeBase);
  return { release: bumped.length > 0, bumped };
}

/** The packages on their own version line whose shipped files (the manifest, its `files`, a README, LICENSE or NOTICE) differ from
 *  the merge base's while the version does not: the release would find that version published with other bytes and stop. */
export async function staleOwnVersions(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const stale = [];
  for (const directory of ownVersionPackages) {
    const was = await gitShow(root, mergeBase, `packages/${directory}/package.json`);
    const now = await readOptional(join(root, 'packages', directory, 'package.json'));
    if (was === null || now === null) continue;
    const manifest = JSON.parse(now);
    if (JSON.parse(was).version !== manifest.version) continue;
    const shipped = path => path === 'package.json' || /^(README|LICENSE|LICENCE|NOTICE)(\.|$)/i.test(path)
      || (manifest.files ?? []).some(entry => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));
    const changed = (await git(root, ['diff', '--name-only', mergeBase, '--', `packages/${directory}`])).split('\n').filter(Boolean)
      .map(path => path.slice(`packages/${directory}/`.length));
    if (changed.some(shipped)) stale.push(directory);
  }
  return stale;
}

/** The packages on their own version line whose version differs from the merge base's, `[{ directory, was, now }]`. Only the release
 *  sets it; a package the base does not have is new. */
export async function movedOwnVersions(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const moved = [];
  for (const directory of ownVersionPackages) {
    const was = await gitShow(root, mergeBase, `packages/${directory}/package.json`);
    const now = await readOptional(join(root, 'packages', directory, 'package.json'));
    if (was === null || now === null) continue;
    const [before, after] = [JSON.parse(was).version, JSON.parse(now).version];
    if (before !== after) moved.push({ directory, was: before, now: after });
  }
  return moved;
}

/** Whether a changelog's text has the section for `version`. */
export const hasVersionSection = (text, version) => text.split('\n').some(line => isVersionHeading(line, version));

// The Python client, parcha-agentrun (python/), is on a version line of its own too: python/pyproject.toml's version, above the 0.2.x
// the old hosted SDK left on PyPI (scripts/python-release.mjs checks it). The same two rules hold for it as for the packages above.
const PYTHON_PROJECT = 'python/pyproject.toml';
/** The version a pyproject.toml's [project] table names, or undefined. */
export const pythonVersionOf = text => /^\[project\][\s\S]*?^version\s*=\s*"([^"]*)"/m.exec(text)?.[1];
/** What the Python client publishes, by its path under python/: its project, README, LICENSE and NOTICE, and its package. */
const pythonShipped = path => ['pyproject.toml', 'README.md', 'LICENSE', 'NOTICE'].includes(path) || path.startsWith('agentrun/');

/** The newest release tag (v*) reachable from HEAD, or null when there is none. */
async function lastReleaseTag(root) {
  try {
    return (await git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/** Whether the Python client's published files differ from the last release's (the newest v* tag reachable from HEAD) while
 *  its version does not: the release would find that version on PyPI already and publish nothing. Against the last release,
 *  not the pull request's base, so a client change merged in an earlier pull request still needs the release to bump it.
 *  With no release tag, or a release that had no client, nothing has been published to go stale. `base` is the caller's. */
export async function stalePython(root, base) {
  void base;
  const tag = await lastReleaseTag(root);
  if (tag === null) return false;
  const was = await gitShow(root, tag, PYTHON_PROJECT);
  const now = await readOptional(join(root, PYTHON_PROJECT));
  if (was === null || now === null || pythonVersionOf(was) !== pythonVersionOf(now)) return false;
  const under = list => list.split('\n').filter(Boolean).map(path => path.slice('python/'.length));
  const changed = under(await git(root, ['diff', '--name-only', tag, '--', 'python']));
  const added = under(await git(root, ['ls-files', '--others', '--exclude-standard', '--', 'python']));
  return [...changed, ...added].some(pythonShipped);
}

/** The Python client's version move against the merge base, `{ was, now }`, or null. Only the release sets it. A base on a
 *  pre-release (0.3.0a0, before the client was published) had no line yet, so the move that starts it is no move. */
export async function movedPython(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const was = await gitShow(root, mergeBase, PYTHON_PROJECT);
  const now = await readOptional(join(root, PYTHON_PROJECT));
  if (was === null || now === null) return null;
  const [before, after] = [pythonVersionOf(was), pythonVersionOf(now)];
  if (before === after || !/^\d+\.\d+\.\d+$/.test(before ?? '')) return null;
  return { was: before, now: after };
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const root = defaultRoot;
  if (args[0] === '--check') {
    const fragments = await loadFragments(root);
    const base = option('--base');
    if (!base || /^0+$/.test(base)) { console.log(`Changes: ${fragments.length} fragment(s) valid. No base commit given, so the Unreleased sections were not compared.`); return; }
    const { fold: isFold, edited } = await unreleasedEdits(root, base);
    assert.deepEqual(edited, [], `An Unreleased section is edited in ${edited.join(', ')}. Add a fragment in changes/ instead (see CONTRIBUTING.md); only the release fold edits it.`);
    const { release } = await releaseCommit(root, base);
    if (!release) {
      const moved = await movedOwnVersions(root, base);
      if (moved.length) throw new Error(moved.map(({ directory, was, now }) => `packages/${directory} moved its version from ${was} to ${now}; the release sets it (docs/releasing.md), so a pull request leaves it at ${was}`).join('\n'));
      const python = await movedPython(root, base);
      if (python) throw new Error(`python moved its version from ${python.was} to ${python.now}; the release sets it (docs/releasing.md), so a pull request leaves it at ${python.was}`);
    }
    const stale = release ? await staleOwnVersions(root, base) : [];
    if (stale.length) throw new Error(`${stale.map(directory => `packages/${directory}`).join(', ')} changed the files it publishes and kept its version; the release sets its next version in its package.json (it is published at its own version, and a release stops on a version already published with other bytes)`);
    if (release && await stalePython(root, base)) throw new Error(`python changed the files it publishes and kept its version ${pythonVersionOf(await readFile(join(root, PYTHON_PROJECT), 'utf8'))}; the release sets its next version in python/pyproject.toml (PyPI holds each version once, and the release skips one already there)`);
    console.log(`Changes: ${fragments.length} fragment(s) valid; no Unreleased section edited${isFold ? ' (the fold)' : ''}.`);
  } else if (args[0] === '--fold') {
    const version = args[1];
    // A version the root changelog already has (the release workflow's fold at the tag) keeps the date its release pull request gave it.
    const date = option('--date') ?? sectionDate(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), version) ?? new Date().toISOString().slice(0, 10);
    const result = await fold(root, version, date);
    console.log(`Folded ${result.folded} fragment(s) into ${result.files.join(', ') || 'no changelog'}.`);
    if (result.shipped.length) console.log(`${result.shipped.join(', ')} shipped in ${result.previous} (its tag carried them) and went into its section.`);
  } else throw new Error('Usage: node scripts/changes.mjs --check [--base <commit>] | --fold <version> [--date YYYY-MM-DD]');
}
if (isMain(import.meta)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
