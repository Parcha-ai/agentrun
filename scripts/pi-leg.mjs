#!/usr/bin/env node
// One pi version for every package whose ranges accept it, while the workspace develops on the lockfile's version.
//
// `node scripts/pi-leg.mjs --pi <version> (--plan | --scratch) [--only <name,...>] [--require-all] [--npm "<command>"] [--out <file>]`
//
// A workspace is in the leg when each pi-family peer range it declares accepts the version. `--plan` prints the leg and
// changes nothing. `--scratch` says the checkout is disposable: the script pins the family at the version in the root
// manifest and in each leg workspace's, so the root holds one copy of each family package at that version and every
// leg workspace loads it, as a host's install of these packages does (other workspaces keep their own copies, nested).
// It fails unless every family package a leg workspace declares, and the chord and pi-ai its pi-durable loads, is that
// one copy at that version, then builds the workspace and runs each leg workspace's type-check and tests with
// PI_EXPECT_VERSION set. A leg workspace that depends on another pi workspace runs only with that one in the leg: their
// tests load both in one process.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The pi family: the packages that are released together and break together in a minor. */
export const FAMILY = ['@earendil-works/pi-durable', '@earendil-works/chord', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'];
/** The packages Pi provides to the packages it loads, which Pi's package guidance asks to be peers at `*`. pi-durable and
 *  chord are not among them: their ranges are bounded. */
export const HOST_PROVIDED = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'];
/** The npm every leg installs with: npm 10 can keep a locked copy beside the version it installs. */
export const NPM_VERSION = '11.21.0';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (version) => {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`${version} is not a plain x.y.z version`);
  return match.slice(1).map(Number);
};
const compare = (a, b) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const TESTS = { '>=': (c) => c >= 0, '>': (c) => c > 0, '<=': (c) => c <= 0, '<': (c) => c < 0, '=': (c) => c === 0 };

/** `name`'s peer range as comparators. Only the shapes the manifests use are read: `*` on a package Pi provides (any
 *  version), and space-separated `>=`, `>`, `<=`, `<`, `=` or bare `x.y.z` comparators. Any other shape is refused, and
 *  so is `*` on any other package, never guessed. */
export function parseRange(range, name) {
  const text = String(range).trim();
  if (text === '*') {
    if (HOST_PROVIDED.includes(name)) return [];
    throw new Error(`${name} has the range "*": only a package Pi provides (${HOST_PROVIDED.join(', ')}) may; bound it, such as ">=1.0.4 <1.3.0"`);
  }
  return text.split(/\s+/).map((part) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!match) throw new Error(`${name} has the range "${range}", a shape this script does not read: use comparators such as ">=1.0.4 <1.3.0"`);
    return { op: match[1] ?? '=', version: match[2] };
  });
}
export const accepts = (range, version, name) => { parse(version); return parseRange(range, name).every(({ op, version: bound }) => TESTS[op](compare(version, bound))); };

/** The pi-family names a manifest declares as peers, and those it installs for its own tests (dependencies and dev). */
export const familyPeers = (manifest) => Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => FAMILY.includes(name));
export const familyInstalled = (manifest) => FAMILY.filter((name) => name in { ...manifest.dependencies, ...manifest.devDependencies });

/** Which workspaces run on `version`. `workspaces` is `[{ name, dir, manifest }]`; a pi workspace is one with a pi-family
 *  peer. `out` says why a pi workspace is not in the leg; `refused` names a leg workspace whose pi workspace dependency
 *  is not in it. */
export function legOf(workspaces, version, only) {
  parse(version);
  const pi = workspaces.filter((w) => familyPeers(w.manifest).length > 0);
  if (only) for (const name of only) if (!pi.some((w) => w.name === name)) throw new Error(`${name} is not a workspace with a pi-family peer`);
  const out = [];
  const leg = pi.filter((w) => {
    if (only && !only.includes(w.name)) { out.push({ name: w.name, why: 'not asked for (--only)' }); return false; }
    const refusing = familyPeers(w.manifest).filter(([name, range]) => !accepts(range, version, name));
    if (refusing.length) out.push({ name: w.name, why: refusing.map(([name, range]) => `${name} ${range}`).join(', ') });
    return refusing.length === 0;
  });
  const names = new Set(leg.map((w) => w.name));
  const refused = [];
  for (const w of leg) {
    const needs = Object.keys({ ...w.manifest.dependencies, ...w.manifest.devDependencies }).filter((name) => pi.some((p) => p.name === name) && !names.has(name));
    if (needs.length) refused.push({ name: w.name, needs });
  }
  return { version, leg: leg.map((w) => w.name), out, refused, pi: pi.map((w) => w.name) };
}

/** The workspaces of the repository at `root`: each `dir/*` pattern of its manifest, one level deep. */
export function readWorkspaces(root) {
  const patterns = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  return patterns.flatMap((pattern) => {
    if (!/^[\w.-]+\/\*$/.test(pattern)) throw new Error(`the workspace pattern "${pattern}" is not one this script reads (dir/*)`);
    const base = join(root, pattern.slice(0, -2));
    return readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
      .map((entry) => { const dir = join(base, entry.name); return { name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }; });
  });
}

/** The copy of `name` a module in `dir` loads: the nearest `node_modules/<name>` above the directory's real path, as
 *  Node resolves a bare import. */
export function resolvedFrom(dir, name) {
  for (let at = realpathSync(dir); ; at = dirname(at)) {
    const manifest = join(at, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) return { version: JSON.parse(readFileSync(manifest, 'utf8')).version, path: realpathSync(dirname(manifest)) };
    if (at === dirname(at)) return undefined;
  }
}

/** Every family package a leg workspace installs, and the chord and pi-ai its pi-durable loads, at `version`: the
 *  mismatches, empty when the leg runs on what it was asked for. */
export function checkResolved(workspace, version) {
  const rows = familyInstalled(workspace.manifest).map((name) => ({ from: workspace.name, name, ...resolvedFrom(workspace.dir, name) }));
  const durable = rows.find((row) => row.name === '@earendil-works/pi-durable');
  if (durable?.path) for (const name of ['@earendil-works/chord', '@earendil-works/pi-ai']) rows.push({ from: `${workspace.name}'s pi-durable`, name, ...resolvedFrom(durable.path, name) });
  return { rows, wrong: rows.filter((row) => row.version !== version) };
}

function argsOf(argv) {
  const args = { only: undefined, requireAll: false, plan: false, scratch: false, npm: 'npm', out: undefined, pi: undefined, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => { if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`); return argv[(i += 1)]; };
    if (flag === '--pi') args.pi = value();
    else if (flag === '--only') args.only = value().split(',').filter(Boolean);
    else if (flag === '--require-all') args.requireAll = true;
    else if (flag === '--plan') args.plan = true;
    else if (flag === '--scratch') args.scratch = true;
    else if (flag === '--npm') args.npm = value();
    else if (flag === '--out') args.out = value();
    else if (flag === '--root') args.root = resolve(value());
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.pi) throw new Error('--pi <version> is required');
  if (args.plan === args.scratch) throw new Error('give --plan (change nothing) or --scratch (this checkout is disposable: its manifests and lockfile are rewritten)');
  return args;
}

function run(command, args, options) {
  const [bin, ...pre] = command.split(/\s+/).filter(Boolean);
  console.log(`$ ${[bin, ...pre, ...args].join(' ')}`);
  return spawnSync(bin, [...pre, ...args], { stdio: 'inherit', ...options }).status ?? 1;
}

function main() {
  const args = argsOf(process.argv.slice(2));
  const workspaces = readWorkspaces(args.root);
  const plan = legOf(workspaces, args.pi, args.only);
  const report = { ...plan, resolved: [], steps: [] };
  const write = () => { if (args.out) { mkdirSync(dirname(resolve(args.out)), { recursive: true }); writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`); } };
  console.log(`pi ${args.pi}: in the leg: ${plan.leg.join(', ') || 'none'}`);
  for (const { name, why } of plan.out) console.log(`pi ${args.pi}: not in the leg: ${name} (${why})`);
  let failed = false;
  for (const { name, needs } of plan.refused) { console.log(`pi ${args.pi}: REFUSED: ${name} depends on ${needs.join(', ')}, which is not in the leg; one process would load two pi-durable versions`); failed = true; }
  if (args.requireAll && plan.out.length) { console.log(`pi ${args.pi}: FAILED: --require-all, and ${plan.out.length} pi workspace(s) are not in the leg`); failed = true; }
  if (failed || args.plan || plan.leg.length === 0) { write(); process.exit(failed ? 1 : 0); }

  const npmVersion = spawnSync(args.npm.split(/\s+/)[0], [...args.npm.split(/\s+/).slice(1), '--version'], { encoding: 'utf8' }).stdout?.trim();
  if (npmVersion !== NPM_VERSION) { console.log(`pi ${args.pi}: FAILED: the install needs npm ${NPM_VERSION}; "${args.npm}" is ${npmVersion || 'not runnable'}`); write(); process.exit(1); }
  const leg = workspaces.filter((w) => plan.leg.includes(w.name));
  const packages = FAMILY.filter((name) => leg.some((w) => familyInstalled(w.manifest).includes(name)));
  // Each install names its packages: an install over the lockfile that only reads changed manifests can keep the locked
  // copy. The root's pins put the one copy at the top, where pi-durable resolves its own chord and pi-ai; each leg
  // workspace's pins make it load that copy instead of its locked one.
  const pins = ['install', '--save-dev', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund'];
  const installs = [[...pins, ...packages.map((name) => `${name}@${args.pi}`)],
    ...leg.map((w) => [...pins, '-w', w.name, ...familyInstalled(w.manifest).map((name) => `${name}@${args.pi}`)])];
  for (const install of installs) {
    const rc = run(args.npm, install, { cwd: args.root });
    report.steps.push({ step: install.join(' '), rc });
    if (rc !== 0) { write(); process.exit(1); }
  }
  const ls = spawnSync(args.npm.split(/\s+/)[0], [...args.npm.split(/\s+/).slice(1), 'ls', ...packages, ...leg.flatMap((w) => ['-w', w.name])], { cwd: args.root, encoding: 'utf8' });
  console.log(ls.stdout);
  const invalid = ls.stdout.split('\n').filter((line) => /\binvalid\b|UNMET|\bmissing\b/.test(line));
  if (invalid.length) { console.log(`pi ${args.pi}: FAILED: npm ls reports ${invalid.length} broken edge(s)`); failed = true; }
  const copies = new Map();
  for (const workspace of leg) {
    const { rows, wrong } = checkResolved(workspace, args.pi);
    report.resolved.push(...rows);
    for (const row of rows) { console.log(`resolved from ${row.from}: ${row.name} ${row.version ?? 'unresolved'} ${row.path ?? ''}`); copies.set(row.name, new Set([...(copies.get(row.name) ?? []), row.path])); }
    if (wrong.length) { console.log(`pi ${args.pi}: FAILED: ${workspace.name} resolves ${wrong.map((row) => `${row.name} ${row.version ?? 'unresolved'} (from ${row.from})`).join(', ')}`); failed = true; }
  }
  for (const [name, paths] of copies) if (paths.size > 1) { console.log(`pi ${args.pi}: FAILED: the leg loads ${paths.size} copies of ${name}: ${[...paths].join(', ')}`); failed = true; }
  if (failed) { write(); process.exit(1); }
  const env = { ...process.env, PI_EXPECT_VERSION: args.pi };
  const build = run('npm', ['run', 'build'], { cwd: args.root, env });
  report.steps.push({ step: 'build', rc: build });
  if (build !== 0) { write(); process.exit(1); }
  for (const workspace of leg) {
    for (const step of ['typecheck', 'test']) {
      if (!workspace.manifest.scripts?.[step]) continue;
      const rc = run('npm', ['run', step, '-w', workspace.name], { cwd: args.root, env });
      report.steps.push({ workspace: workspace.name, step, rc });
      if (rc !== 0) failed = true;
    }
  }
  for (const { workspace, step, rc } of report.steps) if (workspace) console.log(`pi ${args.pi}: ${workspace} ${step} ${rc === 0 ? 'passed' : `FAILED (exit ${rc})`}`);
  console.log(`pi ${args.pi}: ran ${plan.leg.length} of ${plan.pi.length} pi workspaces: ${plan.leg.join(', ')}`);
  write();
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) { console.error(`pi-leg: ${error.message}`); process.exit(2); }
}
