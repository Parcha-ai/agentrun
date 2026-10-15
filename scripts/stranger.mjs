#!/usr/bin/env node
// The stranger test: a package installed into an empty directory, with an empty environment and home, runs the one command
// its README gives a newcomer, and the output is compared with what the spec expects. The spec for a package lives in
// scripts/stranger/<name>.json; a package with no no-key path says so there and is reported, not failed. A spec with
// `examples` also walks the package's keyless examples against the published package (see `walkExamples`).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveDependency } from './pi-family-pins.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MISSING = 'no-key path missing';

/** The `index`th fenced block of `language` under the heading `heading`, up to the next heading of the same or higher level. */
export function extractSnippet(markdown, { heading, fence, index = 0 }) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && line.replace(/^#+\s*/, '').trim() === heading);
  assert.ok(start >= 0, `README has no heading "${heading}"`);
  const level = lines[start].match(/^#+/)[0].length;
  const blocks = [];
  let open;
  for (const line of lines.slice(start + 1)) {
    if (open === undefined && new RegExp(`^#{1,${level}}\\s`).test(line)) break;
    const opening = open === undefined && /^```(\S*)\s*$/.exec(line);
    if (opening) open = { language: opening[1], body: [] };
    else if (open !== undefined && /^```\s*$/.test(line)) { blocks.push(open); open = undefined; }
    else if (open !== undefined) open.body.push(line);
  }
  const matching = blocks.filter(block => block.language === fence);
  assert.ok(matching[index], `README has no ${fence} block number ${index} under "${heading}"`);
  return matching[index].body.join('\n') + '\n';
}

/** Whether a finished command is what the spec expects; `[]` when it is. */
export function judge(spec, result) {
  const problems = [];
  const expected = spec.expect.exitCode ?? 0;
  if (result.exitCode !== expected) problems.push(`exit code ${result.exitCode}, expected ${expected}`);
  if (result.timedOut) problems.push(`no exit within ${spec.timeoutMs} ms`);
  const output = `${result.stdout}${result.stderr}`;
  if (!new RegExp(spec.expect.pattern, 'm').test(output)) problems.push(`output does not match /${spec.expect.pattern}/`);
  return problems;
}

export const isMissing = spec => spec.expect === MISSING;

export function validateSpec(spec, name) {
  assert.equal(typeof spec.package, 'string', `${name}: package`);
  if (isMissing(spec)) { assert.ok(typeof spec.reason === 'string' && spec.reason.length > 0, `${name}: a missing path needs a reason`); return spec; }
  assert.ok(Array.isArray(spec.install) && spec.install.length > 0, `${name}: install lists the repository packages to pack`);
  assert.ok(Array.isArray(spec.command) && spec.command.length > 0, `${name}: command`);
  assert.equal(typeof spec.expect?.pattern, 'string', `${name}: expect.pattern`);
  assert.ok(Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0, `${name}: timeoutMs`);
  if (spec.readmeInstall !== undefined) {
    for (const key of ['readme', 'heading', 'fence']) assert.equal(typeof spec.readmeInstall[key], 'string', `${name}: readmeInstall.${key}`);
  }
  if (spec.examples !== undefined) {
    for (const key of ['readme', 'heading', 'fence', 'dir']) assert.equal(typeof spec.examples[key], 'string', `${name}: examples.${key}`);
    assert.ok(Number.isInteger(spec.examples.timeoutMs) && spec.examples.timeoutMs > 0, `${name}: examples.timeoutMs`);
  }
  return spec;
}

/** A package name from an install argument: `@scope/name@tag` and `name@1.2.3` name `@scope/name` and `name`. */
const nameOf = argument => { const at = argument.indexOf('@', 1); return at > 0 ? argument.slice(0, at) : argument; };

/**
 * The `npm install` arguments of a README's install line (the block a spec's `readmeInstall` names: one `npm install ...`
 * command), as a stranger types it. `packed` maps a package name to a tarball; that package's argument becomes the tarball
 * and every other argument stays as the README writes it, so its peers resolve to whatever the registry serves now. Each
 * packed package must be on the line. Only plain arguments are taken: a line that needs a shell to read it is refused.
 */
export function readmeInstallArgs(snippet, packed = new Map()) {
  const lines = snippet.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.equal(lines.length, 1, `The install block holds one command, not ${lines.length}`);
  const [npm, verb, ...rest] = lines[0].split(/\s+/);
  assert.ok(npm === 'npm' && (verb === 'install' || verb === 'i'), `The install line runs npm install: ${lines[0]}`);
  for (const argument of rest) assert.match(argument, /^[A-Za-z0-9@._/^~=+-]+$/, `The install line needs a shell to read "${argument}"`);
  const unused = new Set(packed.keys());
  const args = rest.map(argument => {
    const tarball = argument.startsWith('-') ? undefined : packed.get(nameOf(argument));
    if (tarball === undefined) return argument;
    unused.delete(nameOf(argument));
    return tarball;
  });
  assert.deepEqual([...unused], [], `The install line does not install ${[...unused].join(', ')}`);
  return ['install', ...args];
}

export async function loadSpec(name) {
  assert.match(name, /^[a-z0-9-]+$/, 'A spec name is lowercase letters, digits and dashes');
  return validateSpec(JSON.parse(await readFile(join(root, 'scripts/stranger', `${name}.json`), 'utf8')), name);
}

/** The environment a stranger starts with: the PATH, an empty home and a private npm cache, nothing else. */
export const strangerEnv = (path, home, cache) => ({ PATH: path, HOME: home, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });

/**
 * `env -i`, the empty environment; the shell never adds to it. With `group`, the command leads a process group of its own,
 * and a timeout (and the end of the command) kills every process of the group: an example starts instances of its own.
 */
function runCommand(command, args, { cwd, env, timeoutMs, group = false }) {
  return new Promise(resolvePromise => {
    const child = spawn('/usr/bin/env', ['-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    const killGroup = () => { if (group && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ESRCH: nothing left */ } } };
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; if (group) killGroup(); else child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); killGroup(); resolvePromise({ exitCode: code ?? -1, stdout, stderr, timedOut }); });
  });
}

async function pack(directories, destination) {
  const tarballs = [];
  for (const directory of directories) {
    const [packed] = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: join(root, 'packages', directory) })).stdout);
    tarballs.push(join(destination, packed.filename));
  }
  return tarballs;
}

// The pi-durable and chord versions the repository's tests run on: what the root lockfile resolves for packages/pi.
function developedVersions(rootLock) {
  const result = {};
  for (const name of ['@earendil-works/pi-durable', '@earendil-works/chord']) {
    result[name] = resolveDependency(rootLock, 'packages/pi', name)?.version;
    if (!result[name]) throw new Error(`The repository lockfile does not resolve ${name} for packages/pi`);
  }
  return result;
}

/** The exit code for a child's close event. A child killed by a signal has no code, and a null code must not read as success. */
export function exitCodeOf(code, signal) {
  if (typeof code === 'number') return code;
  return signal ? 128 + (osConstants.signals[signal] ?? 0) || 1 : 1;
}

/**
 * `readmeLine`: install with the README's own install line (`readmeInstall`) instead of the spec's package and pinned
 * peers. With `registry` the line runs as written; without, this tree's packed package takes its place on the line and
 * the peers stay as written, so the result says whether the next release installs the way the README says.
 */
export async function stranger(name, { registry = false, tarballs: given, readmeLine = false, examplesOnly = false } = {}) {
  const spec = await loadSpec(name);
  if (isMissing(spec)) return { name, status: 'missing', reason: spec.reason };
  assert.ok(!readmeLine || spec.readmeInstall, `${name}: the spec names no README install line (readmeInstall)`);
  assert.ok(!readmeLine || !given, 'A README install line packs its own tarballs');
  assert.ok(!examplesOnly || spec.examples, `${name}: the spec names no examples to walk`);
  const work = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'stranger-'));
  try {
    const [project, home, cache, packs] = ['project', 'home', 'cache', 'packs'].map(part => join(work, part));
    for (const directory of [project, home, cache, packs]) await mkdir(directory);
    const env = strangerEnv(process.env.PATH, home, cache);
    if (examplesOnly) {
      const walked = await walkExamples(spec, work, env);
      const failed = walked.results.filter(result => result.status === 'failed');
      return { name, status: failed.length ? 'failed' : 'passed', problems: failed.flatMap(result => result.problems.map(problem => `${result.name}: ${problem}`)), examples: walked };
    }
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages;
    const developed = developedVersions(lock);
    const peers = (spec.peers ?? []).map(peer => (registry || !(peer in developed) ? peer : `${peer}@${developed[peer]}`));
    let installArgs;
    if (readmeLine) {
      const line = extractSnippet(await readFile(join(root, spec.readmeInstall.readme), 'utf8'), spec.readmeInstall);
      const packed = new Map();
      if (!registry) {
        const tarballs = await pack(spec.install, packs);
        for (const [i, directory] of spec.install.entries()) {
          packed.set(JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8')).name, tarballs[i]);
        }
      }
      // Scripts, audit and fund change nothing about what resolves.
      installArgs = [...readmeInstallArgs(line, packed), '--ignore-scripts', '--no-audit', '--no-fund'];
    } else {
      let sources;
      if (registry) sources = [`${spec.package}@beta`, ...(spec.companions ?? []).map(companion => `${companion}@beta`)];
      else sources = given ?? await pack(spec.install, packs);
      installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...sources, ...peers];
    }
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'stranger', private: true, type: 'module' }));
    const install = await runCommand('npm', installArgs, { cwd: project, env, timeoutMs: 300_000 });
    if (install.exitCode !== 0) return { name, status: 'failed', problems: [`npm install failed (${install.exitCode}): ${install.stderr.slice(-2000)}`] };
    for (const file of spec.files ?? []) {
      let text = extractSnippet(await readFile(join(root, file.readme), 'utf8'), file);
      for (const [from, to] of file.replace ?? []) { assert.ok(text.includes(from), `${name}: "${from}" is not in the README snippet`); text = text.replaceAll(from, to); }
      await writeFile(join(project, file.name), text);
    }
    const [command, ...args] = spec.command;
    const result = await runCommand(command, args, { cwd: project, env, timeoutMs: spec.timeoutMs });
    const problems = judge(spec, result);
    // A spec with `examples` also checks the package's keyless examples against the registry, whatever this run installed.
    let walked;
    if (spec.examples && !readmeLine) {
      walked = await walkExamples(spec, work, env);
      for (const failure of walked.results.filter(entry => entry.status === 'failed')) problems.push(...failure.problems.map(problem => `example ${failure.name}: ${problem}`));
    }
    return { name, status: problems.length ? 'failed' : 'passed', problems, examples: walked, output: `${result.stdout}${result.stderr}`.slice(-2000) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---- the examples' Since cells ----------------------------------------------------------------------------------------

/** `X.Y.Z` or `X.Y.Z-tag.N` as numbers; a release sorts above its own prereleases. Anything else is refused. */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(text);
  assert.ok(match, `"${text}" is not a version (X.Y.Z or X.Y.Z-tag.N)`);
  return { core: match.slice(1, 4).map(Number), tag: match[4], n: match[5] === undefined ? 0 : Number(match[5]) };
}

/** -1, 0 or 1: whether version `a` is older than, the same as, or newer than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (const [i, part] of x.core.entries()) if (part !== y.core[i]) return part < y.core[i] ? -1 : 1;
  if (x.tag === undefined || y.tag === undefined) return x.tag === y.tag ? 0 : x.tag === undefined ? 1 : -1;
  if (x.tag !== y.tag) return x.tag < y.tag ? -1 : 1;
  return Math.sign(x.n - y.n);
}

/**
 * The rows of an examples index that link an example's directory (`| [name](name/) | ... |`), with their Since and CI cells,
 * read by the table's header names so a new column cannot shift them.
 */
export function parseIndex(markdown) {
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const lines = markdown.split('\n');
  const at = lines.findIndex(line => /^\|\s*Example\s*\|/.test(line));
  assert.ok(at >= 0, 'the index has no table headed "Example"');
  const header = cells(lines[at]);
  const [since, ci] = ['Since', 'CI'].map(name => header.indexOf(name));
  assert.ok(since >= 0 && ci >= 0, `the index table needs "Since" and "CI" columns, has: ${header.join(', ')}`);
  const rows = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    const row = cells(line);
    const link = /^\[([^\]]+)\]\(([^)]+)\/\)$/.exec(row[0]);
    if (link && link[1] === link[2]) rows.push({ name: link[1], since: row[since], ci: row[ci] });
  }
  return rows;
}

/**
 * Which examples to walk against the registry whose `beta` tag is `beta`: those that run with no key (CI "yes") and whose
 * Since is at or below it. An example above it is skipped with its reason. A keyless example must name a version.
 */
export function selectExamples(rows, beta) {
  const run = []; const skipped = [];
  for (const { name, since, ci } of rows) {
    if (ci !== 'yes') { skipped.push({ name, reason: `not keyless (CI "${ci}")` }); continue; }
    assert.ok(/^\d/.test(since), `${name}: a keyless example's Since is a published version, not "${since}"`);
    if (compareVersions(since, beta) > 0) skipped.push({ name, reason: `needs ${since}, and the registry's beta is ${beta}` });
    else run.push({ name, since });
  }
  return { run, skipped };
}

/** The `npm install` arguments of the index's install block, with the package at `version` instead of `@beta`. */
export function examplesInstallArgs(block, packageName, version) {
  const lines = block.split('\n').map(line => line.trim()).filter(line => /^npm (install|i) /.test(line));
  assert.equal(lines.length, 1, `the install block has one npm install line, not ${lines.length}`);
  assert.ok(lines[0].split(/\s+/).includes(`${packageName}@beta`), `the install line names ${packageName}@beta`);
  return readmeInstallArgs(lines[0], new Map([[packageName, `${packageName}@${version}`]]));
}

/**
 * The Since cells, enforced: for every keyless example whose Since is at or below the registry's `beta`, install exactly
 * that version in an empty directory the way "Run one from an install" says, copy the example's files, run `node main.ts`
 * and expect its `ok:` line. An example above the beta is skipped with a reason. Results are `{ name, since, status, ... }`.
 */
async function walkExamples(spec, work, env) {
  const { examples } = spec;
  const npm = (args, cwd, timeoutMs = 300_000) => runCommand('npm', args, { cwd, env, timeoutMs });
  const tag = await npm(['view', spec.package, 'dist-tags.beta'], work, 60_000);
  const beta = tag.stdout.trim();
  assert.ok(tag.exitCode === 0 && beta, `the registry has no beta tag for ${spec.package}: ${tag.stderr.slice(-500)}`);
  const index = await readFile(join(root, examples.readme), 'utf8');
  const { run, skipped } = selectExamples(parseIndex(index), beta);
  const results = skipped.map(({ name, reason }) => ({ name, status: 'skipped', reason }));
  for (const version of [...new Set(run.map(example => example.since))]) {
    const project = join(work, `examples-${version}`);
    await mkdir(project);
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'stranger-examples', private: true, type: 'module' }));
    const args = [...examplesInstallArgs(extractSnippet(index, examples), spec.package, version), '--ignore-scripts', '--no-audit', '--no-fund'];
    const install = await npm(args, project);
    for (const { name, since } of run.filter(example => example.since === version)) {
      if (install.exitCode !== 0) { results.push({ name, since, status: 'failed', problems: [`npm install ${spec.package}@${version} failed (${install.exitCode}): ${install.stderr.slice(-1000)}`] }); continue; }
      const target = join(project, name);
      await cp(join(root, examples.dir, name), target, { recursive: true, filter: source => !/(^|\/)README\.md$/.test(source) });
      const result = await runCommand('node', ['main.ts'], { cwd: target, env, timeoutMs: examples.timeoutMs, group: true });
      const problems = judge({ expect: { exitCode: 0, pattern: '^ok: ' }, timeoutMs: examples.timeoutMs }, result);
      const output = `${result.stdout}${result.stderr}`;
      if (/^not ok/m.test(output)) problems.push('the output says "not ok"');
      // The first line that says why (a SyntaxError for a missing export, a "not ok"), else the last line of the output.
      const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
      if (problems.length) problems.push(`output: ${(lines.find(line => /Error|not ok/.test(line)) ?? lines.at(-1) ?? '(none)').slice(0, 300)}`);
      results.push({ name, since, status: problems.length ? 'failed' : 'passed', problems, output: output.slice(-1500) });
    }
  }
  return { beta, results };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = name => { const at = args.indexOf(name); if (at < 0) return undefined; return args.splice(at, 2)[1]; };
  const image = flag('--docker');
  const tarballDir = flag('--tarballs');
  const registry = args.includes('--registry');
  const readmeLine = args.includes('--readme-line');
  const examplesOnly = args.includes('--examples');
  const names = args.filter(arg => !arg.startsWith('--'));
  if (names.length !== 1) { console.error('usage: node scripts/stranger.mjs <name> [--registry] [--readme-line] [--examples] [--docker IMAGE]\nnames: ' + (await readdir(join(root, 'scripts/stranger'))).map(file => file.replace(/\.json$/, '')).join(' ')); process.exit(2); }
  const [name] = names;
  if (image && readmeLine) throw new Error('--readme-line runs on this machine, not with --docker');
  if (image) {
    // The packages are packed here; the container installs them. It gets the repository read-only for the README and the spec.
    const spec = await loadSpec(name);
    if (isMissing(spec)) { console.log(`${name}: ${MISSING}: ${spec.reason}`); return; }
    const packs = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'stranger-packs-'));
    try {
      // With --registry the container installs @beta from npm and nothing is packed here.
      if (!registry) await pack(spec.install, packs);
      const inner = ['run', '--rm', '-v', `${root}:/repo:ro`, '-v', `${packs}:/packs:ro`, image, 'node', '/repo/scripts/stranger.mjs', name, ...(registry ? ['--registry'] : ['--tarballs', '/packs'])];
      const done = await new Promise(resolvePromise => spawn('docker', inner, { stdio: 'inherit' }).on('close', (code, signal) => resolvePromise(exitCodeOf(code, signal))));
      process.exitCode = done;
    } finally { await rm(packs, { recursive: true, force: true }); }
    return;
  }
  const given = tarballDir ? (await readdir(tarballDir)).filter(file => file.endsWith('.tgz')).map(file => join(tarballDir, file)) : undefined;
  const outcome = await stranger(name, { registry, tarballs: given, readmeLine, examplesOnly });
  if (outcome.examples) {
    console.log(`${name}: examples against the registry's beta ${outcome.examples.beta}`);
    for (const { name: example, since, status, reason, problems } of outcome.examples.results) {
      console.log(status === 'skipped' ? `  ${example}: skipped, ${reason}` : `  ${example} (Since ${since}): ${status}${problems?.length ? `: ${problems.join('; ').slice(0, 400)}` : ''}`);
    }
  }
  if (outcome.status === 'missing') console.log(`${name}: ${MISSING}: ${outcome.reason}`);
  else if (outcome.status === 'passed') console.log(`${name}: passed`);
  else { console.error(`${name}: failed\n${outcome.problems.join('\n')}\n--- output (tail) ---\n${outcome.output ?? ''}`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
