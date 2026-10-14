#!/usr/bin/env node
// Changelog fragments: one file per pull request in changes/, folded into the CHANGELOGs by the release. Nothing but the release
// edits an Unreleased section, so two pull requests never touch the same lines.
//   node scripts/changes.mjs --check [--base <commit>]   validate fragments; fail an edit of any Unreleased section
//   node scripts/changes.mjs --fold <version> [--date YYYY-MM-DD]   move each fragment into the CHANGELOG its package names
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const kinds = ['breaking', 'feature', 'fix', 'ci', 'docs'];
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

const changelogPaths = async root => ['CHANGELOG.md', ...[...(await workspacePackages(root)).keys()].sort().map(directory => `packages/${directory}/CHANGELOG.md`)];
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
  const lines = was.split('\n');
  appendToUnreleased(lines, bullets);
  while (lines.at(-1) === '') lines.pop();
  return unreleasedSection(`${lines.join('\n')}\n`) === unreleasedSection(is ?? '');
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

/**
 * Folds the release into the changelogs. Every changelog is visited: one whose Unreleased section holds bullets or that gets
 * fragments has that section renamed `## <version> (<date>)`, with the fragments' bullets after its own, and a new empty
 * Unreleased section opened above it. The root changelog is dated also when it holds nothing and the release has fragments. A
 * fragment goes to its package's own changelog, else the root. A changelog with neither held bullets nor fragments is untouched;
 * one that already has the version's section gets the fragments' bullets appended to it. A held package (its manifest says
 * `"private": true`) ships nothing in this release, so its changelog is never dated: its fragments' bullets are appended to its
 * Unreleased section, which keeps its name and its entries.
 */
export async function fold(root, version, date) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, 'The version is like 0.1.0-beta.13');
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, 'The date is YYYY-MM-DD');
  const directories = await workspacePackages(root);
  const fragments = await loadFragments(root);
  // Every changelog that exists is visited, so a package changelog that holds bullets and gets no fragment is dated too.
  const targets = new Map([['CHANGELOG.md', []]]);
  for (const file of await changelogPaths(root)) if (file !== 'CHANGELOG.md' && await readOptional(join(root, file)) !== null) targets.set(file, []);
  for (const fragment of [...fragments].sort(foldOrder)) {
    const files = new Set();
    for (const name of fragment.packages) files.add(await changelogFor(root, directories, name));
    for (const file of files) targets.set(file, [...(targets.get(file) ?? []), bulletOf(fragment.body)]);
  }
  // Every new text is built before anything is written, and a failed write puts the changelogs and fragments back, so a retry
  // never appends a bullet twice.
  const writes = [];
  for (const [file, bulletsOfFile] of targets) {
    let bullets = bulletsOfFile;
    const original = await readFile(join(root, file), 'utf8');
    const lines = original.split('\n');
    const existing = lines.findIndex(line => isVersionHeading(line, version));
    const unreleased = lines.findIndex(unreleasedHeading);
    if (await heldChangelog(root, file)) {
      // A package this release does not publish gets no version section: its fragments join what its Unreleased section holds.
      if (bullets.length === 0) continue;
      assert.ok(unreleased >= 0, `${file} has no Unreleased heading to add to`);
      appendToUnreleased(lines, bullets);
    } else if (existing >= 0) {
      if (bullets.length === 0) continue;
      lines.splice(sectionEnd(lines, existing), 0, ...bullets);
    } else {
      if (unreleased < 0 && bullets.length === 0) continue;
      assert.ok(unreleased >= 0, `${file} has no Unreleased heading to fold`);
      const held = lines.slice(unreleased + 1, sectionEnd(lines, unreleased)).some(line => line.trim());
      // The root always gets the version's section (the release preflight requires it), also when every change is a package's.
      if (file === 'CHANGELOG.md' && !held && bullets.length === 0 && fragments.length > 0) bullets = ['- Package changes only; see the package changelogs.'];
      if (!held && bullets.length === 0) continue;
      lines.splice(sectionEnd(lines, unreleased), 0, ...(held ? [] : ['']), ...bullets);
      const heading = lines[unreleased];
      lines.splice(unreleased, 1, heading, '', `## ${version} (${date})`);
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
  return { folded: fragments.length, files: changed };
}

/** Whether a changelog's text has the section for `version`. */
export const hasVersionSection = (text, version) => text.split('\n').some(line => isVersionHeading(line, version));

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
    console.log(`Changes: ${fragments.length} fragment(s) valid; no Unreleased section edited${isFold ? ' (the fold)' : ''}.`);
  } else if (args[0] === '--fold') {
    const version = args[1];
    const result = await fold(root, version, option('--date') ?? new Date().toISOString().slice(0, 10));
    console.log(`Folded ${result.folded} fragment(s) into ${result.files.join(', ') || 'no changelog'}.`);
  } else throw new Error('Usage: node scripts/changes.mjs --check [--base <commit>] | --fold <version> [--date YYYY-MM-DD]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
