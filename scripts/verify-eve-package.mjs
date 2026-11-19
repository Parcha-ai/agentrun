#!/usr/bin/env node
// Exercise built release archives in an ordinary eve project. No workspace links or model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain } from './is-main.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|NODE_OPTIONS|NODE_PATH)/i.test(key)));

const TAIL = 5000;
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch {} };
async function groupGone(pid, ms) {
  for (const end = Date.now() + ms; groupAlive(pid);) { if (Date.now() > end) return false; await sleep(25); }
  return true;
}

/** One step of the check, in its own process group. On timeout, too much output or a step that exits with processes of
 *  its own still running, the whole group gets SIGTERM, then SIGKILL after `grace` ms. The shutdown starts when the
 *  step's process exits, not when its pipes close (a child of the group could hold them open), and the step settles
 *  only once the group is gone: the consumer directory's cleanup never runs beside a live step. Each stream keeps at
 *  most its last `maxBuffer` bytes while the pipes go on draining. A failure names the command, its exit code or
 *  signal, whether it timed out, and the tails of stdout and stderr, each labelled. A SIGINT or SIGTERM to this process
 *  while the step runs (its own group doesn't get the terminal's) kills the group and rejects, the error's `stoppedBy` set,
 *  once the group is gone, so the caller's cleanup still runs. */
export function runStep(command, args, { cwd, env, timeout = 180_000, maxBuffer = 8 * 1024 * 1024, grace = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const kept = { stdout: [], stderr: [] };
    const keptBytes = { stdout: 0, stderr: 0 };
    const written = { stdout: 0, stderr: 0 };
    let timedOut = false; let over = ''; let killer; let spawnError; let settled = false;
    const child = spawn(command, args, { cwd, env, detached: true, stdio: 'pipe' });
    const stop = () => {
      if (killer || child.pid === undefined) return;
      signalGroup(child.pid, 'SIGTERM');
      killer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), grace);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    // SIGKILL at once, not stop()'s grace: the caller removes the consumer folder next, so nothing a step tidies survives.
    let stoppedBy;
    const cancel = signal => { stoppedBy = signal; signalGroup(child.pid, 'SIGKILL'); };
    process.once('SIGINT', cancel).once('SIGTERM', cancel);
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      written[name] += chunk.length; kept[name].push(chunk); keptBytes[name] += chunk.length;
      while (keptBytes[name] > maxBuffer) {
        const first = kept[name][0]; const extra = keptBytes[name] - maxBuffer;
        if (first.length <= extra) { kept[name].shift(); keptBytes[name] -= first.length; }
        else { kept[name][0] = first.subarray(extra); keptBytes[name] -= extra; }
      }
      if (written[name] > maxBuffer && !over) { over = name; stop(); }
    });
    const closed = new Promise(done => child.on('close', done));
    const settle = (code, signal, left = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killer); process.off('SIGINT', cancel).off('SIGTERM', cancel);
      const text = name => Buffer.concat(kept[name]).toString('utf8');
      const stdout = text('stdout');
      if (code === 0 && !timedOut && !over && !spawnError && !left && !stoppedBy) return resolve(stdout);
      const how = [
        stoppedBy ? `stopped by ${stoppedBy}` : '',
        timedOut ? `timed out after ${Date.now() - started} ms (limit ${timeout} ms)` : '',
        over ? `${over} over ${maxBuffer} bytes (written ${written[over]}, kept the last ${keptBytes[over]})` : '',
        spawnError ? String(spawnError.message) : '', left,
        code !== null && code !== undefined ? `exit code ${code}` : signal ? `signal ${signal}` : '',
      ].filter(Boolean).join('; ');
      const tail = name => `--- ${name} (last ${TAIL} chars) ---\n${text(name).slice(-TAIL)}`;
      reject(Object.assign(new Error(`eve package consumer step failed: ${[command, ...args].join(' ')}\n${how}\n${tail('stdout')}\n${tail('stderr')}`), { stoppedBy }));
    };
    child.on('error', error => {
      spawnError = error;
      if (child.pid === undefined) settle(null, null); // never started: no group, no exit to wait for
    });
    child.on('exit', async (code, signal) => {
      // The step has ended: waiting for its group below is cleanup, not the step, so it can't count as a timeout.
      clearTimeout(timer);
      let left = '';
      if (groupAlive(child.pid)) {
        stop();
        if (!await groupGone(child.pid, grace + 5_000)) left = 'its process group outlived SIGKILL';
      }
      if (await Promise.race([closed.then(() => true), sleep(1_000).then(() => false)]) === false) {
        child.stdout.destroy(); child.stderr.destroy();
      }
      settle(code, signal, left);
    });
  });
}

/** `tarballs` are the exact archives already packed and scanned by verify-packages. */
export async function verifyEvePackage({ root = repository, tarballs, parentDirectory = tmpdir() }) {
  for (const name of ['client', 'dsl', 'eve']) assert.ok(tarballs[name], `Missing ${name} package archive`);
  const temporary = await mkdtemp(join(parentDirectory, 'agentrun-eve-consumer-'));
  const consumer = join(temporary, 'app');
  const env = { ...cleanEnvironment(), DO_NOT_TRACK: '1', NO_COLOR: '1' };
  const commands = [];
  async function run(command, args, offline = true) {
    const stdout = await runStep(command, args, { cwd: consumer, env: offline ? {
      ...env, NODE_OPTIONS: `--import=${join(temporary, 'deny-network.mjs')}`,
    } : env });
    commands.push({ command: [command === process.execPath ? 'node' : command, ...args], status: 'passed' });
    return stdout;
  }
  try {
    await mkdir(join(consumer, 'agent/extensions'), { recursive: true });
    await mkdir(join(consumer, 'agent/lib'), { recursive: true });
    const manifest = await json(join(root, 'packages/eve/package.json'));
    const typescript = await json(join(root, 'node_modules/typescript/package.json'));
    const nodeTypes = await json(join(root, 'node_modules/@types/node/package.json'));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'agentrun-eve-package-consumer', version: '1.0.0', private: true, type: 'module',
    }, null, 2));
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
      ...['client', 'dsl', 'eve'].map(name => resolve(tarballs[name])), `eve@${manifest.peerDependencies.eve}`,
      `typescript@${typescript.version}`, `@types/node@${nodeTypes.version}`], false);
    for (const name of ['client', 'dsl', 'eve']) {
      const installed = join(consumer, `node_modules/@parcha/agentrun-${name}`);
      assert.ok((await lstat(installed)).isDirectory(), `${name} must be an installed archive, not a workspace symlink`);
      assert.equal((await json(join(installed, 'package.json'))).version, manifest.version);
    }
    await writeFile(join(temporary, 'deny-network.mjs'), `import net from 'node:net';
import http from 'node:http'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('Networking prohibited in eve package verification'); };
globalThis.fetch = deny; net.Socket.prototype.connect = deny;
http.request = deny; http.get = deny; https.request = deny; https.get = deny; syncBuiltinESMExports();
`);
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      noEmit: true, skipLibCheck: true, types: ['node'],
    }, include: ['agent/**/*.ts'] }));
    // No consumer build.externalDependencies: the installed extension must carry that requirement.
    await writeFile(join(consumer, 'agent/agent.ts'), `import { defineAgent } from 'eve';
export default defineAgent({ model: 'anthropic/claude-haiku-4.5', modelContextWindowTokens: 200_000 });
`);
    await writeFile(join(consumer, 'agent/instructions.ts'), `import { defineInstructions } from 'eve/instructions';
export default defineInstructions({ content: 'Read the requested value using the original read tool.' });
`);
    await writeFile(join(consumer, 'agent/lib/tools.ts'), `export const calls: unknown[] = [];
export async function readValue(input: Record<string, unknown>) {
  calls.push(input);
  return { value: input.value };
}
`);
    await writeFile(join(consumer, 'agent/extensions/agentrun.ts'), `import agentrun from '@parcha/agentrun-eve';
import * as engine from '@parcha/agentrun-dsl';
import { readValue } from '../lib/tools.js';
export default agentrun({
  baseUrl: 'https://agentrun.example/v2', apiKey: 'fake-test-key', agentId: 'package-consumer',
  instructions: 'Read the requested value using the original read tool.', learning: false,
  workflows: { engine, policy: () => 'allow', tools: [{
    name: 'mcp:fixture/read', nativeName: 'read', description: 'Read an existing value.',
    input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    output_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    permission: 'allow', readOnly: true, execute: readValue,
  }] },
});
`);
    await writeFile(join(consumer, 'imports.mjs'), `import assert from 'node:assert/strict';
import agentrun from '@parcha/agentrun-eve';
import { learned_workflow } from '@parcha/agentrun-eve/tools';
assert.equal(typeof agentrun, 'function'); assert.ok(learned_workflow);
assert.ok(agentrun({ baseUrl: 'https://agentrun.example/v2', apiKey: 'fake-test-key', agentId: 'notes', instructions: 'Original policy.' }));
`);
    await run(process.execPath, ['imports.mjs']);
    await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
    await run('npm', ['exec', '--offline', '--', 'eve', 'build']);
    const packagedDsl = join(consumer, '.output/server/node_modules/@parcha/agentrun-dsl');
    assert.equal((await json(join(packagedDsl, 'schema/workflow.schema.json'))).$id,
      'https://agentrun.ai/schema/v2/workflow.schema.json', 'The deployed server must retain the DSL package assets');
    await writeFile(join(consumer, 'production-smoke.mjs'), `import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from './.output/server/node_modules/@parcha/agentrun-dsl/dist/index.js';
import { calls, readValue } from './agent/lib/tools.ts';
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };
const workflow = { v: 2, name: 'read-value', schemas: { Input: schema, Output: schema }, input: { schemaId: 'Input' },
  output: { schemaId: 'Output', path: 'result' }, root: { node: 'chain', steps: [
    { node: 'call', label: 'read', via: 'tool', tool: 'mcp:fixture/read', args: { value: '{value}' }, out: 'Output', as: 'result', deadline_s: 5 },
  ] } };
assert.equal(validateWorkflow(workflow).ok, true);
const result = await runWorkflow(workflow, { value: 'fresh consumer value' }, {
  runEffect: async ({ node, input }) => { assert.equal(node.tool, 'mcp:fixture/read'); return readValue(input); },
});
assert.equal(result.status, 'complete'); assert.deepEqual(result.output, { value: 'fresh consumer value' });
assert.deepEqual(calls, [{ value: 'fresh consumer value' }]);
console.log('Installed eve mount and deployed workflow callback passed without network or model credentials.');
`);
    await run(process.execPath, ['production-smoke.mjs']);
    return { status: 'passed', version: manifest.version, eve: manifest.peerDependencies.eve,
      installedArchives: ['client', 'dsl', 'eve'], workspaceLinks: false, agentBuildOverrides: false,
      productionSchema: true, originalCallback: true, runtimeNetwork: 'prohibited', paidCalls: 0, commands };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta)) {
  const [directory, output] = process.argv.slice(2);
  assert.ok(directory && process.argv.length <= 4, 'Usage: node scripts/verify-eve-package.mjs TARBALL_DIRECTORY [RECEIPT_JSON]');
  const version = (await json(join(repository, 'packages/eve/package.json'))).version;
  const tarballs = Object.fromEntries(['client', 'dsl', 'eve'].map(name => [name,
    join(resolve(directory), `parcha-agentrun-${name}-${version}.tgz`)]));
  try {
    const result = await verifyEvePackage({ tarballs });
    if (output) await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.stoppedBy ? 128 + constants.signals[error.stoppedBy] : 1;
  }
}
