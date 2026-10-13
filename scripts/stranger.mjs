#!/usr/bin/env node
// The stranger test: a package installed into an empty directory, with an empty environment and home, runs the one command
// its README gives a newcomer, and the output is compared with what the spec expects. The spec for a package lives in
// scripts/stranger/<name>.json; a package with no no-key path says so there and is reported, not failed.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  return spec;
}

export async function loadSpec(name) {
  assert.match(name, /^[a-z0-9-]+$/, 'A spec name is lowercase letters, digits and dashes');
  return validateSpec(JSON.parse(await readFile(join(root, 'scripts/stranger', `${name}.json`), 'utf8')), name);
}

/** The environment a stranger starts with: the PATH, an empty home and a private npm cache, nothing else. */
export const strangerEnv = (path, home, cache) => ({ PATH: path, HOME: home, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });

function runCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise(resolvePromise => {
    // env -i is the empty environment; the shell never adds to it.
    const child = spawn('/usr/bin/env', ['-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolvePromise({ exitCode: code ?? -1, stdout, stderr, timedOut }); });
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

export async function stranger(name, { registry = false, tarballs: given } = {}) {
  const spec = await loadSpec(name);
  if (isMissing(spec)) return { name, status: 'missing', reason: spec.reason };
  const work = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'stranger-'));
  try {
    const [project, home, cache, packs] = ['project', 'home', 'cache', 'packs'].map(part => join(work, part));
    for (const directory of [project, home, cache, packs]) await mkdir(directory);
    const env = strangerEnv(process.env.PATH, home, cache);
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages;
    const developed = developedVersions(lock);
    const peers = (spec.peers ?? []).map(peer => (registry || !(peer in developed) ? peer : `${peer}@${developed[peer]}`));
    let sources;
    if (registry) sources = [`${spec.package}@beta`, ...(spec.companions ?? []).map(companion => `${companion}@beta`)];
    else sources = given ?? await pack(spec.install, packs);
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'stranger', private: true, type: 'module' }));
    const install = await runCommand('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...sources, ...peers], { cwd: project, env, timeoutMs: 300_000 });
    if (install.exitCode !== 0) return { name, status: 'failed', problems: [`npm install failed (${install.exitCode}): ${install.stderr.slice(-2000)}`] };
    for (const file of spec.files ?? []) {
      let text = extractSnippet(await readFile(join(root, file.readme), 'utf8'), file);
      for (const [from, to] of file.replace ?? []) { assert.ok(text.includes(from), `${name}: "${from}" is not in the README snippet`); text = text.replaceAll(from, to); }
      await writeFile(join(project, file.name), text);
    }
    const [command, ...args] = spec.command;
    const result = await runCommand(command, args, { cwd: project, env, timeoutMs: spec.timeoutMs });
    const problems = judge(spec, result);
    return { name, status: problems.length ? 'failed' : 'passed', problems, output: `${result.stdout}${result.stderr}`.slice(-2000) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = name => { const at = args.indexOf(name); if (at < 0) return undefined; return args.splice(at, 2)[1]; };
  const image = flag('--docker');
  const tarballDir = flag('--tarballs');
  const registry = args.includes('--registry');
  const names = args.filter(arg => !arg.startsWith('--'));
  if (names.length !== 1) { console.error('usage: node scripts/stranger.mjs <name> [--registry] [--docker IMAGE]\nnames: ' + (await readdir(join(root, 'scripts/stranger'))).map(file => file.replace(/\.json$/, '')).join(' ')); process.exit(2); }
  const [name] = names;
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
  const outcome = await stranger(name, { registry, tarballs: given });
  if (outcome.status === 'missing') console.log(`${name}: ${MISSING}: ${outcome.reason}`);
  else if (outcome.status === 'passed') console.log(`${name}: passed`);
  else { console.error(`${name}: failed\n${outcome.problems.join('\n')}\n--- output (tail) ---\n${outcome.output ?? ''}`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
