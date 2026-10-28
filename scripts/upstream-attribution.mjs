// The attribution and boundary rules for code from vercel-labs/durable-harness (Apache-2.0), checked on each package as npm
// packs it (verify-packages) and on its source tree (the tests). On EVERY package (boundaryProblems): no Vercel name or
// mark (case-sensitive product names) outside the attribution and the listed allowances, no dependency on or import of
// @workflow/*, @vercel/sandbox or @vercel/agent-runs, no image file, and a copied-file header only where UPSTREAM.json
// records the file, so a package that copies code and forgets its provenance fails closed. On a package that carries
// copied code (attributionProblems), also:
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
/** Vercel's names and marks, as words in a shipped file: case-sensitive, so "the agent runs" is English, not a product. */
export const MARKS = /\bVercel\b|\bWorkflow SDK\b|\bAI Gateway\b|\bAgent Runs\b|\bv0\.dev\b|\bvercel-labs\b/;
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

/** Mentions of a mark that are someone else's words, by package directory: [file, literal, count, why]. The file must hold
 *  the literal exactly `count` times, on lines with no other mark: one more mention, or one fewer, fails. */
export const ALLOWED_MARKS = {
  // pi-browser's synced Stagehand facade names the AI SDK its upstream tested with (nominative use); the file is a snapshot
  // this repository does not edit (AGENTS.md).
  'pi-browser': [
    ['dist/vendor/stagehand-facade/contract.js', 'Vercel AI SDK', 2, "upstream Stagehand's comments"],
    ['dist/vendor/stagehand-facade/contract.d.ts', 'Vercel AI SDK', 1, "upstream Stagehand's comment"],
  ],
};

/** Each `<svg>...</svg>` block in a text. */
const svgBlocks = (text) => [...text.matchAll(/<svg[\s>][\s\S]*?<\/svg>/gi)].map((m) => m[0]);

/** Whether an SVG draws Vercel's mark: the name, or its logo, a lone equilateral triangle with its apex up (a path or a
 *  polygon of exactly three points whose base is level and whose height is 0.866 of the base, within 10%). */
export function svgHasMark(svg) {
  if (MARKS.test(svg)) return true;
  const shapes = [
    ...[...svg.matchAll(/<polygon[^>]*\bpoints\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...svg.matchAll(/<path[^>]*\bd\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
  ];
  return shapes.some(isUpTriangle);
}

/** A polygon's points or a path's commands as absolute vertices: M/L/H/V/Z paths and point lists only; anything with
 *  curves or relative steps is not the logo. */
function isUpTriangle(spec) {
  if (/[a-y]/.test(spec.replace(/e[-+]?\d/g, '')) || /[CQSTA]/i.test(spec)) return false;
  const points = [];
  let x = 0, y = 0;
  const tokens = spec.match(/[MLHVZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let command = 'L';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[MLHVZ]$/i.test(t)) { command = t.toUpperCase(); if (command === 'Z') continue; continue; }
    if (command === 'H') x = Number(t);
    else if (command === 'V') y = Number(t);
    else { x = Number(t); y = Number(tokens[++i]); }
    points.push([x, y]);
  }
  const unique = points.filter(([px, py], i) => !points.slice(0, i).some(([qx, qy]) => Math.abs(px - qx) < 1e-6 && Math.abs(py - qy) < 1e-6));
  if (unique.length !== 3) return false;
  const sorted = [...unique].sort((a, b) => a[1] - b[1]);
  const [apex, b1, b2] = sorted;
  const base = Math.abs(b1[0] - b2[0]);
  if (base === 0 || Math.abs(b1[1] - b2[1]) > base * 0.02) return false;
  const height = b1[1] - apex[1];
  const centered = Math.abs(apex[0] - (b1[0] + b2[0]) / 2) <= base * 0.05;
  return centered && height > 0 && Math.abs(height / base - 0.866) <= 0.0866;
}

const TEXT = /\.(?:[cm]?js|d\.[cm]?ts|ts|json|md|txt|html|css|ya?ml)$|(?:^|\/)(?:NOTICE|LICENSE|README|CHANGELOG)(?:\.[a-z]+)?$/i;

/** The rules every package keeps, as it ships. `allow` is the package's ALLOWED_MARKS entries. Returns problems; empty
 *  passes. */
export async function boundaryProblems(root, { shipped, allow = [] } = {}) {
  const problems = [];
  const all = (await filesUnder(root)).map((path) => relative(root, path).split('\\').join('/'));
  const ships = shipped ? all.filter(shipped) : all;
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) if (banned(name)) problems.push(`package.json ${field} names ${name}`);
  }
  let upstream;
  if (ships.includes(UPSTREAM_FILE)) { try { upstream = JSON.parse(await readFile(join(root, UPSTREAM_FILE), 'utf8')); } catch {} }
  const copied = copiedPaths(upstream);
  const used = new Map();
  for (const name of ships) {
    if (IMAGE.test(name)) { problems.push(`${name}: an image ships`); continue; }
    if (!TEXT.test(name)) continue;
    const text = await readFile(join(root, name), 'utf8').catch(() => '');
    if (/\.(?:[cm]?js|d\.[cm]?ts|ts)$/.test(name)) for (const specifier of specifiersOf(text)) if (banned(packageNameOf(specifier))) problems.push(`${name} imports ${specifier}`);
    // Any package may draw an SVG (a test kit's images); none may draw Vercel's mark in one.
    for (const svg of svgBlocks(text)) if (svgHasMark(svg)) problems.push(`${name}: an SVG with a Vercel mark`);
    if (name === 'NOTICE' || name === UPSTREAM_FILE || name === 'LICENSE') continue;
    text.split('\n').forEach((line, index) => {
      const header = index < 4 && HEADER.test(line);
      if (header && !copied.has(name)) problems.push(`${name}:${index + 1} has a copied-file header, and no UPSTREAM.json records the file`);
      if (!MARKS.test(line) || header) return;
      const allowed = allow.find(([file, literal]) => file === name && line.includes(literal) && !MARKS.test(line.replaceAll(literal, '')));
      if (allowed) { const k = `${allowed[0]} ${allowed[1]}`; used.set(k, (used.get(k) ?? 0) + line.split(allowed[1]).length - 1); return; }
      problems.push(`${name}:${index + 1} names Vercel or one of its marks`);
    });
  }
  for (const [file, literal, count] of allow) {
    const seen = used.get(`${file} ${literal}`) ?? 0;
    if (seen !== count) problems.push(`allowed mark ${file} "${literal}": ${seen} found, ${count} allowed`);
  }
  return problems;
}

/** A copied source file ships as itself and compiled: src/x.ts as dist/x.js and dist/x.d.ts. */
function copiedPaths(upstream) {
  return new Set(Object.keys(upstream?.files ?? {}).flatMap((file) => [file, file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'), file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.d.ts')]));
}

/** Problems with one package directory that carries copied code, as it ships: `root` is the unpacked tarball's `package/`,
 *  or a package's source tree with `shipped` listing what its `files` field ships. The boundary rules, then the
 *  attribution. Returns a list of problems; empty passes. */
export async function attributionProblems(root, { shipped } = {}) {
  const problems = await boundaryProblems(root, { shipped });
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
  for (const name of ships) if (TEXT.test(name) && /<svg[\s>]/i.test(await readFile(join(root, name), 'utf8').catch(() => ''))) problems.push(`${name}: SVG markup`);
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
