// The port of code from vercel-labs/durable-harness (Apache-2.0), regenerated from four inputs and nothing else:
//   1. the pristine upstream files at the pin (vendor/durable-harness/upstream/, never shipped), each checked against the git
//      blob and sha256 UPSTREAM.json records;
//   2. the named patches (vendor/durable-harness/port/patches/<upstream package>/NNN-<slug>.patch), applied to the pristine
//      text in order, with `git apply` and exact context (no fuzz, no -C, no 3-way): each is written against upstream's text,
//      with upstream's module names, so one that is a fix can go back to upstream unchanged;
//   3. the import table (port/imports.json): every module an upstream file imports, and every symbol it takes from one,
//      maps to ours or is a "gap". A module or symbol the table does not hold, or maps to "gap", fails the port by name;
//   4. the generated headers: the copyright and the origin, and a Changed-by line built from the patch list.
// A manifest per upstream package (port/<package>.json) names the files taken and the directory they land in.
//
//   node scripts/port-durable-harness.mjs [<package dir>]           write the output
//   node scripts/port-durable-harness.mjs --check [<package dir>]   regenerate to memory and fail on any byte difference
//                                                                   from the committed files, and on a patch that changes nothing
//   node scripts/port-durable-harness.mjs --drop <patch> [--cascade] [--out <dir>] [<package dir>]
//                                                                   regenerate without one patch (mutants: its Pins test goes red);
//                                                                   a patch written against its text is dropped too with --cascade
//   node scripts/port-durable-harness.mjs --pin <sha> --upstream <clone> [<package dir>]
//                                                                   report an upgrade, in three parts: the pristine diff, the import
//                                                                   table against the new pristine text, and the patches that fail
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM, UPSTREAM_FILE, PRISTINE_DIR } from './upstream-attribution.mjs';
import { gitBlob } from './vendor-durable-harness.mjs';

export const PORT_DIR = 'vendor/durable-harness/port';
const PATCH_FIELDS = ['Patch', 'Reason', 'Upstream', 'Pins'];
/** A line a patch may change when its Pins line says `comments only`. */
const COMMENT_LINE = /^\s*(?:\*|\/\*|\/\/)|^\s*\*\/\s*$/;

const exists = (path) => readFile(path).then(() => true, () => false);
const readJson = async (path, what) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`${what} (${path}) is missing or not JSON`); } };

/** A patch file: its header fields and its diff. Throws, naming the file, on a malformed one. */
export function parsePatch(name, text) {
  const lines = text.split('\n');
  const cut = lines.indexOf('---');
  if (cut < 0) throw new Error(`patch ${name}: no "---" line after its header`);
  const fields = {};
  for (const line of lines.slice(0, cut)) {
    const found = /^([A-Za-z]+): (.+)$/.exec(line);
    if (!found || !PATCH_FIELDS.includes(found[1])) throw new Error(`patch ${name}: header line ${JSON.stringify(line)} is not one of ${PATCH_FIELDS.join(', ')}`);
    if (found[1] === 'Pins') (fields.Pins ??= []).push(found[2]);
    else if (fields[found[1]] !== undefined) throw new Error(`patch ${name}: two ${found[1]} lines`);
    else fields[found[1]] = found[2];
  }
  for (const field of PATCH_FIELDS) if (!fields[field]) throw new Error(`patch ${name}: no ${field} line`);
  if (fields.Patch !== name) throw new Error(`patch ${name}: its Patch line says ${fields.Patch}`);
  if (fields.Upstream !== 'offer' && fields.Upstream !== 'ours') throw new Error(`patch ${name}: Upstream is "offer" or "ours", not ${JSON.stringify(fields.Upstream)}`);
  const diff = lines.slice(cut + 1).join('\n');
  const files = [...diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[1]);
  if (!files.length) throw new Error(`patch ${name}: no "diff --git" in its body`);
  if (files.some((file, i) => file !== [...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)][i][1])) throw new Error(`patch ${name}: a patch changes files in place, never renames`);
  const commentsOnly = fields.Pins.length === 1 && fields.Pins[0] === 'comments only';
  if (commentsOnly) {
    for (const line of diff.split('\n')) {
      if (!/^[-+]/.test(line) || /^(?:---|\+\+\+) /.test(line)) continue;
      if (!COMMENT_LINE.test(line.slice(1)) && line.slice(1).trim() !== '') throw new Error(`patch ${name}: "Pins: comments only" but it changes code: ${line.slice(0, 80)}`);
    }
  }
  return { name, ...fields, diff, files, commentsOnly };
}

/** Every patch of an upstream package, in order. NNN is unique within the package and orders it. */
export async function readPatches(portDir, upstreamPackage) {
  const dir = join(portDir, 'patches', upstreamPackage);
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.patch')).sort();
  const patches = [];
  for (const file of names) {
    if (!/^\d{3}-[a-z0-9][a-z0-9-]*\.patch$/.test(file)) throw new Error(`patch file ${file} is not NNN-<slug>.patch`);
    patches.push(parsePatch(file.slice(0, -'.patch'.length), await readFile(join(dir, file), 'utf8')));
  }
  const numbers = patches.map((p) => p.name.slice(0, 3));
  if (new Set(numbers).size !== numbers.length) throw new Error(`two patches of ${upstreamPackage} share a number: ${numbers.join(', ')}`);
  return patches;
}

/** Apply one patch to the files under `root` (upstream layout), exactly: git's default context, no fuzz. */
function applyPatch(root, patch) {
  try {
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: root, input: patch.diff, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`patch ${patch.name} does not apply: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`);
  }
}

const IMPORT = /\b(import|export)\s+(type\s+)?(?:(\*\s+as\s+\w+)|\{([^}]*)\}|(\w+))?(?:\s*,\s*\{([^}]*)\})?\s*(?:from\s+)?(['"])([^'"]+)\7/g;

/** Rewrite one file's imports through the table; returns the text and whether a module was rewritten. Problems are
 *  collected, never thrown, so one run names every module and symbol the table lacks. */
export function rewriteImports(text, { table, file, manifestFiles, problems, outDir }) {
  let rewritten = false;
  for (const call of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) problems.push(`${file}: a dynamic import or require of ${call[1]} is not supported by the port`);
  const out = text.replace(IMPORT, (whole, keyword, typeOnly, namespace, named, def, named2, quote, spec) => {
    const at = `${file}: ${keyword} from ${spec}`;
    if (spec.startsWith('.')) {
      if (!spec.endsWith(table.relative.from)) { problems.push(`${at}: a relative import that does not end in ${table.relative.from}`); return whole; }
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (!manifestFiles.includes(target)) { problems.push(`${at}: ${target} is not a file of this manifest`); return whole; }
      return whole.replace(`${quote}${spec}${quote}`, `${quote}${spec.slice(0, -table.relative.from.length)}${table.relative.to}${quote}`);
    }
    const entry = table.modules[spec];
    if (!entry) { problems.push(`${at}: module ${spec} is not in the import table`); return whole; }
    if (entry.keep) return whole;
    const members = [named, named2].filter((x) => x !== undefined).flatMap((list) => list.split(',').map((s) => s.trim()).filter(Boolean));
    const symbols = [...members.map((m) => m.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()), ...(def ? ['default'] : []), ...(namespace ? ['*'] : [])];
    let bad = false;
    for (const symbol of symbols) {
      const target = entry.symbols?.[symbol];
      if (target === undefined) { problems.push(`${at}: symbol ${symbol} is not in the import table for ${spec}`); bad = true; }
      else if (target === 'gap') { problems.push(`${at}: symbol ${symbol} is a gap in the import table for ${spec}`); bad = true; }
    }
    if (bad) return whole;
    let renamed = whole;
    for (const symbol of symbols) {
      const target = entry.symbols[symbol];
      if (target !== symbol && symbol !== 'default' && symbol !== '*') renamed = renamed.replace(new RegExp(`(^|[{,\\s])(type\\s+)?${symbol}(?=\\s*[,}\\s])`), (m, pre, ty = '') => `${pre}${ty}${target} as ${symbol}`);
    }
    rewritten = true;
    const spot = posix.relative(posix.dirname(posix.join(outDir, posix.basename(file))), entry.to).replace(/\.ts$/, '.js');
    return renamed.replace(`${quote}${spec}${quote}`, `${quote}${spot.startsWith('.') ? spot : `./${spot}`}${quote}`);
  });
  return { text: out, rewritten };
}

/** The generated header: Vercel's copyright, the origin, and Parcha's change, built from what was done to this file. */
export function header({ upstreamPath, importsRewritten, patches }) {
  const changes = [...(importsRewritten ? ['imports rewritten for AgentRun'] : []), ...(patches.length ? [`patches: ${patches.join(', ')}`] : [])];
  return [
    `// ${UPSTREAM.copyright} Licensed under the Apache License, Version 2.0; see LICENSE in this package.`,
    `// From ${UPSTREAM.repo}, ${upstreamPath} at ${UPSTREAM.commit.slice(0, 10)} (UPSTREAM.json records its blob and sha256).`,
    `// Changed by Parcha, ${changes.length ? changes.join('; ') : 'nothing'}`,
  ].join('\n') + '\n';
}

/** Port one manifest from pristine text read by `read(upstreamPath)`. Returns `{ files: Map<outPath, text>, problems }`;
 *  `problems` is empty when the port is sound. `drop` names patches to leave out; `keepGoing` carries on past a patch that
 *  does not apply (an upgrade report) instead of throwing. */
export async function portManifest({ manifest, read, table, patches, drop = [], keepGoing = false }) {
  const problems = [];
  const root = await mkdtemp(join(tmpdir(), 'agentrun-port-'));
  try {
    const paths = manifest.files.map((f) => posix.join(manifest.upstream, f));
    for (const path of paths) {
      const bytes = await read(path);
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    const touched = new Map(paths.map((p) => [p, []]));
    const failed = [];
    for (const patch of patches) {
      if (drop.includes(patch.name)) continue;
      const outside = patch.files.filter((f) => !paths.includes(f));
      if (outside.length) { problems.push(`patch ${patch.name} changes ${outside.join(', ')}, which the manifest does not take`); continue; }
      try { applyPatch(root, patch); } catch (error) { if (!keepGoing) throw error; failed.push(patch.name); problems.push(error.message); continue; }
      for (const file of patch.files) touched.get(file).push(patch.name);
    }
    const files = new Map();
    const manifestFiles = manifest.files.map((f) => posix.join(manifest.upstream, f));
    for (const [index, path] of paths.entries()) {
      const patched = (await readFile(join(root, path), 'utf8'));
      const { text, rewritten } = rewriteImports(patched, { table, file: path, manifestFiles, problems, outDir: manifest.out });
      files.set(posix.join(manifest.out, manifest.files[index]), header({ upstreamPath: path, importsRewritten: rewritten, patches: touched.get(path) }) + text);
    }
    return { files, problems, failed };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Everything a port reads from one package directory. */
export async function loadPort(dir) {
  const portDir = join(dir, PORT_DIR);
  const table = await readJson(join(portDir, 'imports.json'), 'the import table');
  const upstream = await readJson(join(dir, UPSTREAM_FILE), UPSTREAM_FILE);
  const manifests = [];
  for (const name of (await readdir(portDir)).filter((n) => n.endsWith('.json') && n !== 'imports.json').sort()) {
    const manifest = await readJson(join(portDir, name), `manifest ${name}`);
    manifest.patches = await readPatches(portDir, manifest.package);
    manifests.push(manifest);
  }
  return { portDir, table, upstream, manifests };
}

/** The pristine file of the committed pin, checked against the blob and sha256 UPSTREAM.json records for it. */
function pristineReader(dir, upstream, problems) {
  const recorded = new Map(Object.values(upstream.files ?? {}).map((r) => [r.upstream, r]));
  return async (path) => {
    const bytes = await readFile(join(dir, PRISTINE_DIR, path)).catch(() => undefined);
    if (!bytes) throw new Error(`no pristine copy of ${path} under ${PRISTINE_DIR}`);
    const record = recorded.get(path);
    if (!record) problems.push(`${path}: UPSTREAM.json does not record it`);
    else {
      if (gitBlob(bytes) !== record.blob) problems.push(`${path}: the pristine copy's git blob is not the recorded one`);
      if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) problems.push(`${path}: the pristine copy's sha256 is not the recorded one`);
    }
    return bytes;
  };
}

/** The whole port of one package directory: every manifest's output and the problems. */
export async function portPackage(dir, { drop = [], cascade = false } = {}) {
  const { table, upstream, manifests } = await loadPort(dir);
  const files = new Map();
  const problems = [];
  const read = pristineReader(dir, upstream, problems);
  for (const manifest of manifests) {
    for (const name of drop) if (!manifest.patches.some((p) => p.name === name) && manifests.length === 1) problems.push(`no patch named ${name}`);
    const done = await portManifest({ manifest, read, table, patches: manifest.patches, drop, keepGoing: cascade });
    for (const [path, text] of done.files) files.set(path, text);
    // With `cascade`, a later patch written against a dropped one's text is dropped too, and named: a mutant of the first.
    problems.push(...(cascade ? done.problems.filter((p) => !/^patch .* does not apply/.test(p)) : done.problems));
    if (cascade) for (const name of done.failed) console.error(`dropped with it: ${name} (written against the dropped patch's text)`);
  }
  return { files, problems, manifests };
}

/** `--check`: the regenerated files against the committed ones, byte for byte, and every patch against "dropping it changes
 *  something". Returns the problems, empty when the committed tree is exactly what the port makes. */
export async function checkPort(dir) {
  const { files, problems, manifests } = await portPackage(dir);
  const out = [...problems];
  for (const [path, text] of files) {
    const committed = await readFile(join(dir, path), 'utf8').catch(() => undefined);
    if (committed === undefined) out.push(`${path}: the port makes it and it is not committed`);
    else if (committed !== text) out.push(`${path}: differs from the port's output${firstDifference(committed, text)}`);
  }
  for (const manifest of manifests) {
    for (const patch of manifest.patches) {
      // A later patch written against this one's text no longer applies without it: that is loud, by name, and it counts
      // as the patch mattering. Only a patch whose absence leaves every output byte as it is changes nothing.
      const without = await portPackage(dir, { drop: [patch.name] }).catch((error) => ({ error }));
      if (without.error) continue;
      const same = [...files].every(([path, text]) => without.files.get(path) === text);
      if (same) out.push(`patch ${patch.name} changes nothing: dropping it leaves the output as it is`);
    }
  }
  return out;
}

function firstDifference(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  const at = x.findIndex((line, i) => line !== y[i]);
  return at < 0 && x.length === y.length ? '' : ` (line ${(at < 0 ? Math.min(x.length, y.length) : at) + 1}: committed ${JSON.stringify((x[at] ?? '').slice(0, 70))}, port ${JSON.stringify((y[at] ?? '').slice(0, 70))})`;
}

/** `--pin`: what changes if upstream's text moves to `sha`: per file the pristine diff (lines), the import table's verdict on
 *  the new text, and the patches that no longer apply. Never writes. */
export async function upgradeReport(dir, { sha, upstreamClone }) {
  const { table, upstream, manifests } = await loadPort(dir);
  const git = (...args) => execFileSync('git', ['-C', upstreamClone, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const full = execFileSync('git', ['-C', upstreamClone, 'rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim();
  const report = { from: upstream.commit, to: full, pristine: {}, imports: [], patches: [] };
  const old = pristineReader(dir, upstream, []);
  for (const manifest of manifests) {
    const read = async (path) => Buffer.from(git('show', `${full}:${path}`));
    for (const file of manifest.files) {
      const path = posix.join(manifest.upstream, file);
      const before = (await old(path)).toString('utf8').split('\n'), after = (await read(path)).toString('utf8').split('\n');
      const set = new Set(before), next = new Set(after);
      report.pristine[path] = { removed: before.filter((l) => !next.has(l)).length, added: after.filter((l) => !set.has(l)).length };
    }
    const done = await portManifest({ manifest, read, table, patches: manifest.patches, keepGoing: true });
    for (const problem of done.problems) (/^patch /.test(problem) ? report.patches : report.imports).push(problem);
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); if (at < 0) return undefined; const [, value] = args.splice(at, 2); return value; };
  const has = (name) => { const at = args.indexOf(name); if (at < 0) return false; args.splice(at, 1); return true; };
  const check = has('--check');
  const drop = flag('--drop');
  const outDir = flag('--out');
  const cascade = has('--cascade');
  const pin = flag('--pin');
  const upstreamClone = flag('--upstream');
  const dir = args[0] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', 'packages', 'run-adapters');
  const fail = (lines) => { for (const line of lines) console.error(line); process.exit(1); };
  if (pin) {
    if (!upstreamClone) fail(['--pin needs --upstream <a clone of the upstream repository>']);
    const report = await upgradeReport(dir, { sha: pin, upstreamClone });
    console.log(`Pristine diff, ${report.from.slice(0, 10)} to ${report.to.slice(0, 10)}:`);
    for (const [path, n] of Object.entries(report.pristine)) console.log(`  ${path}: ${n.removed} lines removed, ${n.added} added`);
    console.log(`Import table against the new text: ${report.imports.length ? '' : 'sound'}`);
    for (const line of report.imports) console.log(`  ${line}`);
    console.log(`Patches: ${report.patches.length ? '' : 'every one applies'}`);
    for (const line of report.patches) console.log(`  ${line}`);
    process.exit(report.imports.length || report.patches.length ? 1 : 0);
  }
  if (check) {
    const problems = await checkPort(dir);
    if (problems.length) fail(problems);
    console.log('Port: the committed files are exactly what the pristine copies, the patches and the import table make.');
  } else {
    const { files, problems } = await portPackage(dir, { drop: drop ? [drop] : [], cascade });
    if (problems.length) fail(problems);
    const base = outDir ?? dir;
    for (const [path, text] of files) {
      await mkdir(dirname(join(base, path)), { recursive: true });
      await writeFile(join(base, path), text);
    }
    console.log(`Port: wrote ${files.size} files under ${relative(process.cwd(), base) || '.'}.`);
  }
}
