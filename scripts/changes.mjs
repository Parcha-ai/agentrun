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
export function parseFragment(text, name, known) {
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
  for (const file of names.filter(entry => entry.endsWith('.md') && entry !== 'README.md').sort()) {
    assert.match(file, fragmentName, `changes/${file}: the name is lowercase letters, digits and dashes`);
    fragments.push({ file, ...parseFragment(await readFile(join(root, 'changes', file), 'utf8'), `changes/${file}`, known) });
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

/** The changelogs whose Unreleased section differs from `base`'s, unless the change is the fold: it deletes fragments and adds none. */
export async function unreleasedEdits(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const before = new Set((await git(root, ['ls-tree', '-r', '--name-only', mergeBase, '--', 'changes'])).split('\n').filter(path => /^changes\/[^/]+\.md$/.test(path) && path !== 'changes/README.md'));
  const now = new Set((await readdir(join(root, 'changes')).catch(() => [])).filter(file => file.endsWith('.md') && file !== 'README.md').map(file => `changes/${file}`));
  const added = [...now].filter(path => !before.has(path));
  const deleted = [...before].filter(path => !now.has(path));
  if (deleted.length > 0 && added.length === 0) return { fold: true, edited: [] };
  const edited = [];
  for (const path of await changelogPaths(root)) {
    const was = await gitShow(root, mergeBase, path);
    const is = await readOptional(join(root, path));
    if (unreleasedSection(was ?? '') !== unreleasedSection(is ?? '')) edited.push(path);
  }
  return { fold: false, edited };
}

/** The bullet a fragment becomes: its first line behind "- ", the rest indented under it. */
export const bulletOf = body => body.split('\n').map((line, index) => (index === 0 ? `- ${line}` : line.trim() ? `  ${line}` : '')).join('\n');

/** Whether `line` is the heading of `version`'s section: "## 0.1.0-beta.13, 2026-10-20", "## 0.1.0-beta.13" or "## [0.1.0-beta.13] ...". */
const isVersionHeading = (line, version) => line.startsWith('## ') && line.slice(3).replace(/^\[/, '').split(/[\],\s]/)[0] === version;

const kindOrder = fragment => kinds.indexOf(fragment.kind);

const unreleasedHeading = line => /^## \[?Unreleased\]?\s*$/i.test(line);
const sectionEnd = (lines, heading) => {
  let end = lines.findIndex((line, index) => index > heading && /^## /.test(line));
  if (end < 0) end = lines.length;
  while (end > heading + 1 && lines[end - 1].trim() === '') end--;
  return end;
};

/**
 * Folds the release into the changelogs. A changelog that gets fragments (the root also when its Unreleased section holds
 * bullets) has that section renamed `## <version> (<date>)`, with the fragments' bullets after its own, and a new empty
 * Unreleased section opened above it. A fragment goes to its package's own changelog, else the root. A changelog that
 * gets none is untouched; one that already has the version's section gets the bullets appended to it.
 */
export async function fold(root, version, date) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, 'The version is like 0.1.0-beta.13');
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, 'The date is YYYY-MM-DD');
  const directories = await workspacePackages(root);
  const fragments = await loadFragments(root);
  const targets = new Map([['CHANGELOG.md', []]]);
  for (const fragment of [...fragments].sort((a, b) => kindOrder(a) - kindOrder(b) || a.file.localeCompare(b.file))) {
    const files = new Set();
    for (const name of fragment.packages) {
      const directory = [...directories].find(([, packageName]) => packageName === name)?.[0];
      files.add(directory && await readOptional(join(root, 'packages', directory, 'CHANGELOG.md')) !== null ? `packages/${directory}/CHANGELOG.md` : 'CHANGELOG.md');
    }
    for (const file of files) targets.set(file, [...(targets.get(file) ?? []), bulletOf(fragment.body)]);
  }
  const changed = [];
  for (const [file, bullets] of targets) {
    const lines = (await readFile(join(root, file), 'utf8')).split('\n');
    const existing = lines.findIndex(line => isVersionHeading(line, version));
    const unreleased = lines.findIndex(unreleasedHeading);
    if (existing >= 0) {
      if (bullets.length === 0) continue;
      lines.splice(sectionEnd(lines, existing), 0, ...bullets);
    } else {
      assert.ok(unreleased >= 0, `${file} has no Unreleased heading to fold`);
      const held = lines.slice(unreleased + 1, sectionEnd(lines, unreleased)).some(line => line.trim());
      if (!held && bullets.length === 0) continue;
      lines.splice(sectionEnd(lines, unreleased), 0, ...(held ? [] : ['']), ...bullets);
      const heading = lines[unreleased];
      lines.splice(unreleased, 1, heading, '', `## ${version} (${date})`);
    }
    while (lines.at(-1) === '') lines.pop();
    await writeFile(join(root, file), `${lines.join('\n')}\n`);
    changed.push(file);
  }
  for (const fragment of fragments) await rm(join(root, 'changes', fragment.file));
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
