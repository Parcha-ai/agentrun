// The attribution and boundary rules for a package that carries code from vercel-labs/durable-harness (Apache-2.0),
// checked on the package as npm packs it (verify-packages) and on its source tree (the tests):
//  - NOTICE, LICENSE and vendor/durable-harness/UPSTREAM.json ship; NOTICE says upstream's copyright line verbatim, as
//    UPSTREAM.json records it; UPSTREAM.json records the commit, the license, that upstream has no NOTICE, and per copied
//    file its upstream path, git blob and sha256;
//  - the pristine upstream copies (vendor/durable-harness/upstream/) never ship;
//  - no dependency on, or import of, @workflow/*, @vercel/sandbox or @vercel/agent-runs;
//  - no Vercel name or mark in a shipped file beyond the attribution: NOTICE's line, UPSTREAM.json, and each copied file's
//    header lines; and no image of any kind (a logo is an image), nor SVG markup in any shipped file.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const UPSTREAM = Object.freeze({
  repo: 'github.com/vercel-labs/durable-harness',
  commit: 'ea8aa4060cf4fb8cd39737ce8ab21c4e0f40c741',
  license: 'Apache-2.0',
  copyright: 'Copyright 2026 Vercel Inc.',
});
export const UPSTREAM_FILE = 'vendor/durable-harness/UPSTREAM.json';
export const PRISTINE_DIR = 'vendor/durable-harness/upstream/';
export const NOTICE_LINE = `This product includes software from vercel-labs/durable-harness (https://github.com/vercel-labs/durable-harness), ${UPSTREAM.copyright}, licensed under the Apache License 2.0.`;
export const BANNED_PACKAGES = [/^@workflow\//, /^@vercel\/sandbox$/, /^@vercel\/agent-runs$/];
/** Vercel's names and marks, as words in a shipped file. */
export const MARKS = /\bVercel\b|\bWorkflow SDK\b|\bAI Gateway\b|\bAgent Runs\b|\bv0\.dev\b/i;
const IMAGE = /\.(?:svg|png|jpe?g|gif|webp|ico|bmp|avif)$/i;
/** A copied file's header: Vercel's copyright, where it came from, and Parcha's change. */
const HEADER = /^\/\/ (?:Copyright 2026 Vercel Inc\.|From github\.com\/vercel-labs\/durable-harness, )/;

const packageNameOf = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const banned = (name) => BANNED_PACKAGES.some((pattern) => pattern.test(name));
/** Module specifiers a JavaScript or declaration file names (import, export from, dynamic import, require). */
export function specifiersOf(text) {
  const found = new Set();
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g)) found.add(match[2]);
  return [...found];
}

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Problems with one package directory as it ships: `root` is the unpacked tarball's `package/`, or a package's source
 *  tree with `shipped` listing what its `files` field ships. Returns a list of problems; empty passes. */
export async function attributionProblems(root, { shipped } = {}) {
  const problems = [];
  const all = (await filesUnder(root)).map((path) => relative(root, path).split('\\').join('/'));
  const ships = shipped ? all.filter(shipped) : all;
  const has = (name) => ships.includes(name);
  for (const name of ['NOTICE', 'LICENSE', UPSTREAM_FILE]) if (!has(name)) problems.push(`${name} does not ship`);
  if (has('LICENSE') && !(await readFile(join(root, 'LICENSE'), 'utf8')).includes('Apache License\n                           Version 2.0')) problems.push('LICENSE is not the Apache License 2.0 text');
  if (has('NOTICE') && !(await readFile(join(root, 'NOTICE'), 'utf8')).split('\n').includes(NOTICE_LINE)) problems.push(`NOTICE lacks the attribution line, verbatim: ${NOTICE_LINE}`);
  let upstream;
  if (has(UPSTREAM_FILE)) {
    try { upstream = JSON.parse(await readFile(join(root, UPSTREAM_FILE), 'utf8')); } catch { problems.push(`${UPSTREAM_FILE} is not JSON`); }
    if (upstream) {
      for (const [key, value] of Object.entries(UPSTREAM)) if (upstream[key] !== value) problems.push(`${UPSTREAM_FILE} ${key} is ${JSON.stringify(upstream[key])}, not ${JSON.stringify(value)}`);
      if (upstream.notice !== null) problems.push(`${UPSTREAM_FILE} must record "notice": null (upstream has no NOTICE file at ${UPSTREAM.commit})`);
      if (!upstream.files || typeof upstream.files !== 'object' || Array.isArray(upstream.files)) problems.push(`${UPSTREAM_FILE} has no files map`);
      else for (const [file, record] of Object.entries(upstream.files)) {
        if (typeof record?.upstream !== 'string' || !/^[0-9a-f]{40}$/.test(record?.blob ?? '') || !/^[0-9a-f]{64}$/.test(record?.sha256 ?? '')) problems.push(`${UPSTREAM_FILE} ${file}: needs upstream, blob and sha256`);
      }
    }
  }
  for (const name of ships) if (name.startsWith(PRISTINE_DIR)) problems.push(`${name}: a pristine upstream copy ships`);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) if (banned(name)) problems.push(`package.json ${field} names ${name}`);
  }
  // A copied source file ships compiled: src/x.ts as dist/x.js and dist/x.d.ts.
  const copied = new Set(Object.keys(upstream?.files ?? {}).flatMap((file) => [file, file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'), file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.d.ts')]));
  for (const name of ships) {
    if (IMAGE.test(name)) { problems.push(`${name}: an image ships`); continue; }
    const text = await readFile(join(root, name), 'utf8').catch(() => '');
    if (/<svg[\s>]/i.test(text)) problems.push(`${name}: SVG markup`);
    if (/\.(?:[cm]?js|d\.[cm]?ts|ts)$/.test(name)) for (const specifier of specifiersOf(text)) if (banned(packageNameOf(specifier))) problems.push(`${name} imports ${specifier}`);
    if (name === 'NOTICE' || name === UPSTREAM_FILE || name === 'LICENSE') continue;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (!MARKS.test(line)) return;
      // A copied file's own header (its first lines) may name Vercel; nothing else may.
      if (index < 4 && HEADER.test(line) && copied.has(name)) return;
      problems.push(`${name}:${index + 1} names Vercel or one of its marks`);
    });
  }
  return problems;
}

/** The `files` field of a manifest as a predicate on package-relative paths (enough for the fields this repo uses:
 *  plain paths and directories). */
export function shippedBy(manifest) {
  const entries = ['package.json', ...(manifest.files ?? [])];
  return (path) => entries.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`) || /^(?:README|CHANGELOG|LICENSE|NOTICE)(?:\.[a-z]+)?$/i.test(path));
}

/** Whether a package directory carries durable-harness code (it holds UPSTREAM.json). */
export const carriesUpstream = async (dir) => Boolean(await stat(join(dir, UPSTREAM_FILE)).catch(() => null));
