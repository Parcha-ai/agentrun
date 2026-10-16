#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditBlockers } from './audit-exceptions.mjs';
import { buildOverrides, findDrift } from './pi-family-pins.mjs';
import { recordProblems } from './reference-record.mjs';
import { checkPiFamily, developedVersions, laggingWorkspaces, listCopies } from './consumer-pi.mjs';
import { importsOf } from './package-imports.mjs';
import { runtimeSmokeChecks } from './release-preflight.mjs';

const exec = promisify(execFile);
// `--pi <x.y.z>`: install the clean consumer's pi family at that version instead of the one the repository's lockfile holds.
// Without it the consumer is pinned to the lockfile, as before.
const piFlag = process.argv.indexOf('--pi');
const legPi = piFlag === -1 ? undefined : process.argv[piFlag + 1];
assert.ok(piFlag === -1 || /^\d+\.\d+\.\d+$/.test(legPi ?? ''), `--pi takes a plain x.y.z version, got ${legPi}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receiptDir = join(root, '.release');
const [major, minor] = process.versions.node.split('.').map(Number);
assert.ok(major > 22 || major === 22 && minor >= 19, 'Package verification requires Node.js >=22.19.0');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|NODE_OPTIONS|NODE_PATH)/i.test(key)));
const receipt = { status: 'running', startedAt: new Date().toISOString(), node: process.version, packages: [], demos: [], checks: [], limitations: ['The content scan is heuristic, not proof of complete secret detection.', 'Smoke tests use fake adapters and prohibit networking; live provider behavior is verified separately.', 'License and publication ownership remain separate release decisions.'] };
await mkdir(receiptDir, { recursive: true });
await rm(join(receiptDir, 'typescript-diagnostics.txt'), { force: true });
const writeReceipt = () => writeFile(join(receiptDir, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
await writeReceipt();
const temporary = await mkdtemp(join(tmpdir(), 'agentrun-package-check-'));
/** The pins for a leg that names its own pi version: every @earendil-works package the lockfile holds is pinned to it, by name. */
function piLeg({ held }, version) {
  return { overrides: Object.fromEntries([...held.keys()].map(name => [name, version])), held: new Map([...held.keys()].map(name => [name, new Set([version])])) };
}
async function run(command, args, cwd = root, allowFailure = false, commandEnv = env) {
  try { return { ...(await exec(command, args, { cwd, env: commandEnv, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 })), exitCode: 0 }; }
  catch (error) {
    if (args[0]?.endsWith('/typescript/bin/tsc')) await writeFile(join(receiptDir, 'typescript-diagnostics.txt'), String(error.stdout || error.stderr || ''));
    if (allowFailure && typeof error.code === 'number') return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
    throw new Error(`${command} ${args[0] ?? ''} failed (${error.code ?? 'unknown'}): ${String(error.stderr || error.stdout || '').slice(-5000)}`);
  }
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const forbid = [
  ['machine-specific path', /(?:\/(?:home|Users)\/[^/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s"']+\\)/],
  ['private service endpoint', /https?:\/\/(?:localhost\b|127\.\d+\.\d+\.\d+\b|10\.\d+\.\d+\.\d+\b|192\.168\.\d+\.\d+\b|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b|169\.254\.\d+\.\d+\b|[a-z0-9.-]+\.(?:internal|local|localhost)\b)/i],
  ['embedded credential value', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][A-Za-z0-9_./+=-]{24,}["']/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider secret', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['credential URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
];

// Loopback and private endpoints are refused in every packed file. The browser package names a few loopback URLs on purpose, so
// those exact literals, in those exact files, are removed before the scan; any other loopback string, in any file of any package,
// still fails. Each entry says why it is there, and an entry that matches nothing fails too, so the list cannot go stale.
// Files beyond the common allowlist, by package. The browser package ships its vendored Stagehand facade's provenance file beside the compiled
// copy, so a reader of the tarball can check what was copied; no other package may carry it.
const allowedExtraFiles = {
  'pi-browser': ['package/src/vendor/stagehand-facade/UPSTREAM.json'],
};
const allowedEndpoints = {
  'pi-browser': [
    // Stagehand's trace export is pointed at a closed loopback port (the discard port): nothing listens, nothing leaves the host.
    ['dist/driver/stagehand.js', 'http://127.0.0.1:9/v1/traces'],
    ['dist/driver/stagehand.d.ts', 'http://127.0.0.1:9/v1/traces'],
    // The DevTools endpoint of the Chrome the provider started itself, on the free port it chose.
    ['dist/providers/cdp.js', 'http://127.0.0.1:${port}'],
    ['dist/providers/cdp.js', 'http://127.0.0.1:${local.port}'],
    ['dist/providers/cdp.js', 'http://127.0.0.1:${own.port}'],
    // The fake provider in the test kit (`./testing`) serves its pages from a loopback server of its own.
    ['dist/testing/backend.js', 'http://127.0.0.1:${server.address().port}'],
  ],
};

const usedEndpoints = new Set();

try {
  // JSON keeps the last of two equal keys, so a merge that leaves a key twice passes every later check.
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(root, 'packages', entry.name, 'package.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) continue;
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n', `packages/${entry.name}/package.json is not canonical two-space JSON: a key appears twice, or the layout differs`);
  }
  receipt.checks.push('Every packages/*/package.json is canonical two-space JSON, so no key appears twice.');
  const packageDirectories = ['dsl', 'jev', 'pi', 'pi-durable-disk', 'pi-browser', 'pi-vision', 'pi-transport', 'pi-durable-agent'];
  const tarballs = [];
  for (const directory of packageDirectories) {
    const cwd = join(root, 'packages', directory);
    const manifest = await json(join(cwd, 'package.json'));
    const [packed] = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], cwd)).stdout);
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    const tarball = join(temporary, packed.filename);
    const names = (await run('tar', ['-tzf', tarball])).stdout.trim().split('\n');
    for (const name of names) {
      assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), `Unsafe archive path in ${manifest.name}`);
      assert.ok(name.endsWith('/') || (allowedExtraFiles[directory] ?? []).includes(name) || /^package\/(?:package\.json|README(?:\.md)?|CHANGELOG\.md|LICENSE(?:\.txt|\.md)?|NOTICE(?:\.txt|\.md)?|bin\/archil-scoped|dist\/.+|schema\/.+|skills\/.+)$/.test(name), `File outside the public package allowlist: ${name}`);
      assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|node_modules|\.git|\.cascade|\.release|test|tests)(?:\/|$)/.test(name), `Unexpected packed path: ${name}`);
      assert.ok(!/\.(?:pem|key|p12|pfx|map)$/.test(name), `Unexpected packed file: ${name}`);
    }
    const listing = (await run('tar', ['-tvzf', tarball])).stdout.trim().split('\n');
    assert.ok(listing.every(line => line.startsWith('-') || line.startsWith('d')), 'Packed symlinks and special files are not allowed');
    const extracted = join(temporary, `inspect-${directory}`);
    await mkdir(extracted);
    await run('tar', ['-xzf', tarball, '-C', extracted]);
    for (const name of names.filter(n => !n.endsWith('/'))) {
      const content = await readFile(join(extracted, name), 'utf8');
      const decoded = content.replace(/(?:%[0-9a-f]{2})+/gi, value => { try { return decodeURIComponent(value); } catch { return value; } });
      const scanned = (allowedEndpoints[directory] ?? []).reduce((text, [file, literal]) => (name === `package/${file}` && text.includes(literal) ? (usedEndpoints.add(`${file} ${literal}`), text.replaceAll(literal, '')) : text), content);
      const scannedDecoded = scanned.replace(/(?:%[0-9a-f]{2})+/gi, value => { try { return decodeURIComponent(value); } catch { return value; } });
      for (const [kind, pattern] of forbid) assert.ok(!pattern.test(scanned) && !pattern.test(scannedDecoded), `${kind} found in ${manifest.name}/${name}; content omitted`);
      if (name.endsWith('.js') || name.endsWith('.d.ts')) {
        const imports = importsOf(content);
        for (const dependency of imports) {
          if (dependency.startsWith('.')) {
            const target = resolve(dirname(join(extracted, name)), dependency);
            assert.ok(target.startsWith(join(extracted, 'package') + '/'), `Import escapes package: ${name}`);
          } else if (!dependency.startsWith('node:')) {
            const packageName = dependency.startsWith('@') ? dependency.split('/').slice(0, 2).join('/') : dependency.split('/')[0];
            assert.ok(manifest.dependencies?.[packageName] || manifest.peerDependencies?.[packageName], `Undeclared dependency ${packageName} in ${name}`);
          }
        }
      }
    }
    const fileHash = createHash('sha256').update(await readFile(tarball)).digest('hex');
    receipt.packages.push({ name: manifest.name, version: manifest.version, filename: packed.filename, sha256: fileHash, files: names, size: packed.size, unpackedSize: packed.unpackedSize, license: manifest.license });
    tarballs.push(tarball);
    for (const [file, literal] of allowedEndpoints[directory] ?? []) assert.ok(usedEndpoints.has(`${file} ${literal}`), `Allowed endpoint literal no longer in ${manifest.name}: ${file} ${literal}`);
    console.log(`Packed and inspected ${manifest.name}@${manifest.version} (${names.length} files)`);
  }
  receipt.checks.push('Archive paths, file allowlist, heuristic secret scan, and dependency boundary inspection passed.');
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  // The consumer has no lockfile, so the @earendil-works packages that an upstream @earendil-works package depends on by
  // range float to the newest release, and an upstream package then runs beside siblings it was not released with (a
  // coding agent at one version, its codemode at the next). Each such edge is pinned to the version this repository's
  // lockfile resolves for that parent. Our own packages' peer ranges are not touched: they select what they select.
  const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages ?? {};
  const npmMajor = Number((await run('npm', ['--version'])).stdout.trim().split('.')[0]);
  // The drift check below fails the run if a future npm resolves either override shape differently.
  const pinned = buildOverrides(rootLock, npmMajor);
  const { overrides, held } = legPi ? piLeg(pinned, legPi) : pinned;
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'agentrun-clean-consumer', version: '1.0.0', private: true, type: 'module', overrides }));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...tarballs], consumer);
  const typescript = await json(join(root, 'node_modules', 'typescript', 'package.json'));
  const nodeTypes = await json(join(root, 'node_modules', '@types', 'node', 'package.json'));
  const zod = await json(join(root, 'node_modules', 'zod', 'package.json'));
  // The Pi packages are optional peers of @parcha/agentrun-pi: a host or application supplies them, so the consumer does.
  const peers = [];
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui', '@earendil-works/pi-ai', 'typebox']) peers.push(`${name}@${legPi && name.startsWith('@earendil-works/') ? legPi : (await json(join(root, 'node_modules', name, 'package.json'))).version}`);
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact', `typescript@${typescript.version}`, `@types/node@${nodeTypes.version}`, `zod@${zod.version}`, ...peers], consumer);
  // Every @earendil-works package in the consumer is at a version the repository's lockfile holds for that name.
  const consumerLock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  const drifted = findDrift(consumerLock.packages, held);
  assert.deepEqual(drifted, [], `The consumer holds @earendil-works packages the repository does not hold, or at versions it does not hold: ${drifted.join(', ')}`);
  receipt.checks.push('Every @earendil-works package in the consumer resolves at a version the repository lockfile holds for it.');
  // The versions the consumer landed on are printed and filed before they are judged, so a failure shows what was installed.
  const copies = listCopies(consumerLock.packages);
  const developed = legPi ? { '@earendil-works/pi-durable': legPi, '@earendil-works/chord': legPi } : developedVersions(rootLock);
  const peerRanges = {};
  for (const packed of receipt.packages) {
    const ranges = Object.fromEntries(Object.entries((await json(join(consumer, 'node_modules', packed.name, 'package.json'))).peerDependencies ?? {}).filter(([name]) => name in developed));
    if (Object.keys(ranges).length) peerRanges[packed.name] = ranges;
  }
  receipt.piFamily = { developedOn: developed, ...(legPi ? { leg: legPi } : {}), copies };
  for (const copy of copies) console.log(`Consumer holds ${copy.name}@${copy.version} at ${copy.location}`);
  const piProblems = checkPiFamily(copies, developed, peerRanges, legPi ? [] : laggingWorkspaces(rootLock, developed));
  if (piProblems.length) throw new Error(`The packages installed together do not land on the pi version the repository develops on:\n${piProblems.join('\n')}`);
  receipt.checks.push(`The consumer holds one pi-durable and one chord, at ${developed['@earendil-works/pi-durable']} and ${developed['@earendil-works/chord']}, ${legPi ? `the version this leg names (--pi ${legPi})` : 'the versions the repository develops the durable packages on'}.`);
  for (const packed of receipt.packages) {
    const installed = await json(join(consumer, 'node_modules', packed.name, 'package.json'));
    assert.equal(installed.version, packed.version, `Installed version mismatch: ${packed.name}`);
  }
  receipt.checks.push('Exact tarballs installed in an empty consumer with lifecycle scripts disabled.');

  // Preload before imports: even a dependency cannot quietly call a model in these smoke tests.
  await writeFile(join(consumer, 'deny-network.mjs'), `import net from 'node:net';
import http from 'node:http'; import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Networking prohibited during package smoke tests'); };
globalThis.fetch = denied; net.Socket.prototype.connect = denied;
http.request = denied; http.get = denied; https.request = denied; https.get = denied;
syncBuiltinESMExports();
`);
  const starter = join(temporary, 'starter');
  await cp(join(root, 'examples/starter'), starter, {
    recursive: true, filter: path => !['node_modules', 'dist'].includes(basename(path)),
  });
  receipt.starter = { commands: [], network: 'Build, tests and demonstrations prohibited; installation allowed.' };
  const starterEnv = { ...env, NODE_OPTIONS: `--import=${join(consumer, 'deny-network.mjs')}` };
  async function starterCommand(args, expectedExit = 0, offline = true) {
    const result = await run('npm', args, starter, true, offline ? starterEnv : env);
    receipt.starter.commands.push({ command: ['npm', ...args], ...result });
    assert.equal(result.exitCode, expectedExit, `Standalone starter: npm ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }
  const starterTarballs = tarballs.filter((_, index) => ['dsl', 'jev'].includes(packageDirectories[index]));
  await starterCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...starterTarballs], 0, false);
  assert.ok((await lstat(join(starter, 'node_modules/@parcha/agentrun-dsl'))).isDirectory(), 'Starter must install the DSL package, not a workspace symlink');
  await assert.rejects(lstat(join(starter, 'node_modules/@parcha/agentrun-pi')), { code: 'ENOENT' });
  await starterCommand(['test']);
  const starterOutput = await starterCommand(['start']);
  assert.match(starterOutput, /\[review-policy\]/);
  assert.match(starterOutput, /\[incident-policy\]/);
  assert.doesNotMatch(starterOutput, /\[advert\]/);
  assert.match(starterOutput, /2 passages retained\. The exception stays with the rule\./);
  const missingEvidence = await starterCommand(['start', '--', '--no-evidence'], 2);
  assert.match(missingEvidence, /Needs research: No selected evidence answers:/);
  assert.doesNotMatch(missingEvidence, /passages retained/);
  receipt.starter.status = 'passed';
  receipt.checks.push('Standalone TypeScript starter installed only DSL/Jev tarballs and its own dependencies; strict build, component tests, success and missing-evidence exit 2 passed offline.');
  console.log('Standalone starter: installed packages, strict compilation, tests, evidence selection and missing-evidence exit 2 passed without runtime network.');
  const offlineNode = args => run(process.execPath, ['--import', './deny-network.mjs', ...args], consumer);
  for (const scenario of ['billing', 'technical', 'ambiguous']) {
    const result = JSON.parse((await offlineNode(['node_modules/@parcha/agentrun-dsl/dist/cli.js', 'demo', '--scenario', scenario, '--json'])).stdout);
    assert.equal(result.mode, 'scripted');
    assert.equal(result.scenario, scenario);
    assert.equal(result.result.status, scenario === 'ambiguous' ? 'escalated' : 'complete');
    if (scenario !== 'ambiguous') assert.deepEqual(result.result.output, { queue: scenario, priority: scenario === 'technical' ? 'high' : 'normal' });
    else assert.equal(result.result.escalation.kind, 'human_review');
    assert.ok(result.events.some(event => event.type === 'judge.answered'));
    receipt.demos.push({ scenario, status: result.result.status, output: result.result.output ?? null, events: result.events.map(event => ({ type: event.type, label: event.label })) });
  }
  console.log('Installed CLI: billing, technical, and ambiguous scenarios passed without network.');
  // Every Box provider that pi-transport exports under ./box/* is checked by name, so a new provider adds no line here.
  const transportRoot = join(consumer, 'node_modules/@parcha/pi-transport');
  const transportExports = (await json(join(transportRoot, 'package.json'))).exports;
  const boxProviders = (await readdir(join(transportRoot, 'dist/box'))).filter(file => file.endsWith('.js')).map(file => file.slice(0, -3)).filter(name => transportExports[`./box/${name}`] !== null).sort();
  assert.ok(['docker', 'local'].every(name => boxProviders.includes(name)), `pi-transport exports the providers ${boxProviders.join(', ')}`);
  await writeFile(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow, defineWorkflow, runTypedWorkflow, inspectWorkflow, formatWorkflowTree, authorWorkflow, authorContract, loadAuthorReference } from '@parcha/agentrun-dsl';
import { z } from 'zod';
import { supportTriage } from '@parcha/agentrun-dsl/demo';
import { openRecovery, withRecovery, memoryStore } from '@parcha/agentrun-dsl/recovery';
import { registerStoreConformance } from '@parcha/agentrun-dsl/recovery/testing';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevRunner } from '@parcha/agentrun-jev';
import * as pi from '@parcha/agentrun-pi';
import * as archil from '@parcha/pi-durable-disk';
import * as archilLease from '@parcha/pi-durable-disk/lease';
import * as archilInternals from '@parcha/pi-durable-disk/internals';
import * as browser from '@parcha/pi-browser';
import * as browserAgent from '@parcha/pi-browser/coding-agent';
import * as browserTesting from '@parcha/pi-browser/testing';
import * as browserCdp from '@parcha/pi-browser/providers/cdp';
import * as vision from '@parcha/pi-vision';
import * as visionDurable from '@parcha/pi-vision/durable';
import * as visionTesting from '@parcha/pi-vision/testing';
import * as transport from '@parcha/pi-transport';
import * as transportHands from '@parcha/pi-transport/hands';
import * as transportHome from '@parcha/pi-transport/home';
import * as transportTesting from '@parcha/pi-transport/testing';
import * as piDurable from '@parcha/agentrun-pi/durable';
import * as piWorkflows from '@parcha/agentrun-pi/workflows';
import * as agentHome from '@parcha/pi-durable-agent';
import * as agentExport from '@parcha/pi-durable-agent/export';
import * as piSignin from '@parcha/agentrun-pi/signin';
const { createPiRunner } = pi;
assert.equal('authorWorkflow' in pi, false);
assert.equal(validateWorkflow(supportTriage).ok,true);
const schema=JSON.parse(await readFile(new URL(import.meta.resolve('@parcha/agentrun-dsl/schema')),'utf8'));
assert.equal(schema.$id,'https://agentrun.ai/schema/v2/workflow.schema.json');
const workflow = { v:2, name:'consumer', schemas:{Result:{type:'object',properties:{total:{type:'number'}},required:['total'],additionalProperties:false}},output:{schemaId:'Result',path:'result'},root:{node:'code',label:'add',code:'s => ({result:{total:s.left+s.right}})'}};
assert.equal(validateWorkflow(workflow).ok,true);
assert.deepEqual((await runWorkflow(workflow,{left:2,right:3},{})).output,{total:5});
const recovery=await openRecovery(memoryStore(),workflow,{key:'consumer'});
assert.deepEqual((await runWorkflow(workflow,{left:2,right:3},withRecovery(recovery,{}))).output,{total:5});
await recovery.close(); assert.equal(recovery.resumed,false); assert.equal(typeof registerStoreConformance,'function');
const typed=defineWorkflow({name:'installed-authoring',schemas:{Input:z.strictObject({text:z.string()}),Output:z.strictObject({text:z.string()})},input:'Input',output:{schema:'Output',path:'result'},steps:[{node:'code',label:'copy',code:'s => ({result:{text:s.text}})'}]});
assert.deepEqual((await runTypedWorkflow(typed,{text:'installed'},{})).output,{text:'installed'});
assert.equal(inspectWorkflow(typed).checked,'structure-only');
assert.ok(formatWorkflowTree(inspectWorkflow(typed)).includes('copy [code]'));
assert.deepEqual((await runWorkflow(JSON.parse(JSON.stringify(typed)),{text:'serialized'},{})).output,{text:'serialized'});
const judge=createJevRunner({client:{async systemOne(){return {model:'fake',answers:{ok:{type:'noul',noul:.9}},usage:{input_tokens:1,output_tokens:1}};}}});
assert.equal((await judge({label:'check',kind:'judge',state:{ok:true},questions:{ok:{type:'noul',instructions:'Is it okay?'}}})).answers.ok.noul,.9);
let disposed=false;
const runNode=createPiRunner({model:{},modelRuntime:{},sessionFactory:async options=>({session:{subscribe(){return()=>{};},async abort(){},dispose(){disposed=true;},async prompt(){await options.customTools.find(t=>t.name==='submit').execute('submit',{value:{total:5}});}}})});
assert.deepEqual(await runNode({kind:'agent',label:'fake',system:[],user:'Return total',schema:workflow.schemas.Result}),{total:5});
assert.ok(disposed); assert.equal(typeof authorWorkflow,'function');
assert.equal(typeof archil.openDurableRun,'function'); assert.equal(typeof archilLease.openRunLease,'function'); assert.equal(typeof archilLease.leaseParkTarget,'function'); assert.equal(typeof archilInternals.runPath,'function'); assert.equal('openRunLease' in archil,false); assert.ok(existsSync(archil.ARCHIL_SCOPED)); assert.equal('supervise' in archilLease,false);
assert.ok(browser.BROWSER_TOOLS.length>0); assert.equal(typeof browserAgent.createBrowserExtension,'function'); assert.equal(typeof browserTesting.FakeBackend,'function'); assert.equal(typeof browserCdp.cdpProvider,'function');
assert.deepEqual(Object.keys(vision.READ_MEDIA_PARAMETERS),['ask','from_s','to_s','page','char_offset']); assert.equal(vision.resolveLimits(undefined).image.maxWidth,2000); assert.equal(vision.citation('a.pdf',{page:{from:3,to:3}}),'a.pdf#page=3'); assert.equal(typeof visionDurable.createVisionExtension,'function');
assert.equal((await visionTesting.fakeEyes().see({parts:[],ask:'q'},new AbortController().signal)).text,'fake answer');
assert.equal(typeof transport.parseTransportConfig,'function'); assert.equal(typeof transportHome.moveWorkspace,'function'); assert.equal(typeof transportHome.sealStore,'function'); assert.equal(typeof transportTesting.createBoxConformance,'function');
for (const name of ${JSON.stringify(boxProviders)}) assert.equal(typeof (await import('@parcha/pi-transport/box/'+name))[name+'Boxes'],'function',name);
assert.equal(typeof transportHands.boxEnv,'function');
assert.equal(typeof transportHands.transport,'function'); assert.equal(typeof transport.TransportError,'function');
assert.equal(piDurable.DECISION_RECEIPTS_DOC,'agentrun.decisions'); assert.equal(piDurable.DECISION_ROW_VERSION,1); { let opened=0; const writer=piDurable.createDecisionWriter({open:async()=>{opened++;throw new Error('never opened');}}); await writer.flush(); assert.equal(opened,0); }
assert.equal(typeof piWorkflows.WorkflowStore,'function'); assert.equal(typeof piWorkflows.WorkflowStoreError,'function'); { const dir=await mkdtemp(join(tmpdir(),'wf-store-')); try { assert.deepEqual(await new piWorkflows.WorkflowStore(dir).list(),[]); } finally { await rm(dir,{recursive:true,force:true}); } }
{ const dir=await mkdtemp(join(tmpdir(),'agentrun-agent-home-')); try { const home=await agentHome.createAgentHome(join(dir,'acme'),{definition:{version:1,name:'consumer',instructions:'Answer.',skills:['s'],tools:[]},skills:{'s/SKILL.md':'# S'}}); const started=await agentHome.startRun(home,{runId:'r1',host:'consumer'}); assert.deepEqual(started,{...agentHome.runPaths(home,'r1'),runId:'r1',agent:{instructions:'Answer.',tools:[]},leases:[]}); assert.equal(await readFile(join(started.workspace,'.agents/skills/s/SKILL.md'),'utf8'),'# S'); assert.deepEqual(await agentHome.carryBack(home,started,{outcome:'completed'}),{changed:true,profiles:[],released:[]}); assert.equal((await agentHome.readAgentHome(home)).runs.r1.outcome,'completed'); } finally { await rm(dir,{recursive:true,force:true}); } }
assert.deepEqual([agentExport.EXPORTABLE_KINDS,agentExport.SECRET_KINDS,agentExport.projectForExport],[agentHome.EXPORTABLE_KINDS,agentHome.SECRET_KINDS,agentHome.projectForExport]);
{ const ready=piSignin.checkKeys({name:'consumer',models:{lead:{needs:['text']}},keys:[{env:'CONSUMER_KEY',why:'w',where:'x',required:true}],programs:[],expectedCalls:0,expectedCost:0},{env:{}}); assert.equal(ready.exitCode,2); assert.equal(typeof piSignin.resolveModel,'function'); }
assert.ok(loadAuthorReference('language').includes(authorContract()));
console.log(JSON.stringify({core:true,jev:true,pi:true,archil:true,browser:true,vision:true,transport:true,agent:true,network:'prohibited'}));
`);
  const smoke = JSON.parse((await offlineNode(['smoke.mjs'])).stdout);
  assert.deepEqual(smoke, runtimeSmokeChecks);
  receipt.runtimeSmoke = smoke;
  // The reference example runs in the consumer as a stranger would run it: its pages are served by the browser's fake backend on
  // loopback, so its preload admits loopback only.
  await cp(join(root, 'scripts/deny-remote.mjs'), join(consumer, 'deny-remote.mjs'));
  await cp(join(root, 'examples/reference'), join(consumer, 'reference'), { recursive: true, filter: path => !['node_modules', 'dist'].includes(basename(path)) });
  const expectedRecord = await json(join(root, 'examples/reference/expected.json'));
  const referenceTmp = join(temporary, 'reference-home');
  await mkdir(referenceTmp);
  const reference = await run(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', './deny-remote.mjs', 'reference/run.ts', '--json'], consumer, false, { PATH: process.env.PATH, HOME: referenceTmp, TMPDIR: referenceTmp });
  const referenceRecord = JSON.parse(reference.stdout);
  const referenceProblems = recordProblems(referenceRecord, expectedRecord);
  assert.deepEqual(referenceProblems, [], `The reference job in the consumer printed a record that differs from examples/reference/expected.json (token counts are not compared exactly): ${referenceProblems.join('; ')}`);
  receipt.reference = { status: 'passed', network: 'loopback only', evidence: referenceRecord.evidence, usage: referenceRecord.usage };
  receipt.checks.push('The reference example, copied into the consumer and run with loopback-only networking and no key, printed the record in examples/reference/expected.json.');
  await cp(join(root, 'scripts/verify-pi-install.mjs'), join(consumer, 'verify-pi-install.mjs'));
  receipt.piExtension = JSON.parse((await offlineNode(['verify-pi-install.mjs'])).stdout);
  receipt.checks.push('Packed Pi package installed and discovered by native Pi package manager/resource loader; skill and complete/escalated demos passed offline.');
  const auditRun = await run('npm', ['audit', '--omit=dev', '--json'], consumer, true);
  const audit = JSON.parse(auditRun.stdout);
  await writeFile(join(receiptDir, 'npm-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  assert.ok(audit.metadata?.vulnerabilities, 'npm audit could not produce a vulnerability report');
  const { accepted, blocking } = auditBlockers(audit);
  receipt.audit = { vulnerabilities: audit.metadata.vulnerabilities, accepted, exitCode: auditRun.exitCode };
  assert.equal(accepted.length + blocking.length, audit.metadata.vulnerabilities.high + audit.metadata.vulnerabilities.critical, 'npm audit counts high or critical advisories it does not list; see .release/npm-audit.json');
  assert.deepEqual(blocking, [], 'Production dependencies have high or critical advisories; see .release/npm-audit.json');
  receipt.checks.push(accepted.length ? `Production dependency audit contains no high or critical advisories beyond the accepted, expiring exceptions (${accepted.map(entry => `${entry.package} until ${entry.expires}`).join(', ')}).` : 'Production dependency audit contains no high or critical advisories.');
  await writeFile(join(consumer, 'consumer.ts'), `import { runWorkflow, desugarWorkflow, defineWorkflow, runTypedWorkflow, type Workflow, type WorkflowDeps, type Predicate, type CallPredicate } from '@parcha/agentrun-dsl';
import { z } from 'zod';
import { createJevRunner, type JevOptions } from '@parcha/agentrun-jev';
import { authorWorkflow, type AuthorWorkflowOptions } from '@parcha/agentrun-dsl';
import { createPiRunner, type PiRunnerOptions } from '@parcha/agentrun-pi';
import { openRecovery, withRecovery, memoryStore } from '@parcha/agentrun-dsl/recovery';
const jevOptions: JevOptions = {client:{async systemOne(){return {answers:{ok:{type:'noul',noul:1}}};}}};
const deps: WorkflowDeps = { runJudge: createJevRunner(jevOptions) };
const workflow: Workflow = {v:2,name:'typed',schemas:{Result:{type:'object'}},output:{schemaId:'Result'},root:{node:'chain',steps:[]}};
async function useAll(pi: PiRunnerOptions, author: AuthorWorkflowOptions) {
  const result = await runWorkflow(workflow,{}, {...deps,runNode:createPiRunner(pi)});
  const candidate = await authorWorkflow(author);
  return [result.status,candidate.workflow.name];
}
void useAll;
async function recover(){ const driver=await openRecovery(memoryStore(),workflow,{key:'typed'}); const wrapped: WorkflowDeps = withRecovery(driver,deps); await driver.close(); return wrapped; }
void recover;
const equality: Predicate = {predicate:'field_equals',path:'ready',value:true};
const membership: Predicate = {predicate:'in',path:'status',values:['ready']};
// @ts-expect-error enum_equals is not a workflow poll predicate.
const invalidPoll: CallPredicate = {predicate:'enum_equals',value:'ready'};
const normalized = desugarWorkflow({...workflow,root:{node:'artifact',label:'write',type:'markdown',instructions:'Write'}});
// @ts-expect-error Normalization changes the node discriminant, so the result requires narrowing.
const stillArtifact: 'artifact' = normalized.root.node;
void [equality,membership,invalidPoll,stillArtifact];
const typed = defineWorkflow({name:'consumer-types',schemas:{Input:z.strictObject({text:z.string()}),Output:z.strictObject({text:z.string()})},input:'Input',output:{schema:'Output',path:'result'},steps:[{node:'code',label:'copy',code:'s => ({result:{text:s.text}})'}]});
async function typedConsumer(){
 const result=await runTypedWorkflow(typed,{text:'hello'},{});
 if(result.status==='complete'){
  const text:string=result.output.text;
  // @ts-expect-error inferred output is not a number.
  const invalid:number=result.output.text;
  void [text,invalid];
 }
 // @ts-expect-error input is inferred from the schema.
 await runTypedWorkflow(typed,{text:42},{});
}
void typedConsumer;
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], consumer);
  // pi-ai's declarations name an optional peer of @google/genai that npm does not install, so this file is checked without
  // declaration checking (the package's own declarations are checked by its `verify:tarball`).
  // The durable entry's declarations name pi-durable's, which reach the same pi-ai declarations: checked the same way.
  await writeFile(join(consumer, 'durable-consumer.ts'), `import type { RecoveryJournal, RecoveryStore } from '@parcha/agentrun-dsl/recovery';
import type { RecoveryStore as DurableStore } from '@parcha/agentrun-pi/durable';
const openStore = (store: DurableStore): Promise<RecoveryJournal> => { const contract: RecoveryStore = store; return contract.open({binding:'digest'}); };
void openStore;
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'durable-consumer.ts'], consumer);
  await writeFile(join(consumer, 'jev-consumer.ts'), `import { createJevRunner, type JevJudge, type JevImage } from '@parcha/agentrun-jev';
import type { WorkflowDeps } from '@parcha/agentrun-dsl';
const image: JevImage = { bytes: new Uint8Array([0x89]), mime: 'image/png' };
const judge: JevJudge = createJevRunner({ model: 'jev-1.14.0' });
const asDep: NonNullable<WorkflowDeps['runJudge']> = judge;
const call = (): ReturnType<JevJudge> => judge({ label: 'door', kind: 'judge', state: '<photo>', questions: { door: { type: 'box', instructions: 'the door in <photo>' } }, assets: { '<photo>': image } });
void [asDep, call];
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'jev-consumer.ts'], consumer);
  await writeFile(join(consumer, 'workflows-consumer.ts'), `import { WorkflowStore, WorkflowStoreError, type StoredWorkflow, type WorkflowRevision } from '@parcha/agentrun-pi/workflows';
import type { Workflow } from '@parcha/agentrun-dsl';
const keep = async (store: WorkflowStore, workflow: Workflow): Promise<[StoredWorkflow, WorkflowRevision[], WorkflowStoreError | undefined]> => [await store.save('copy', workflow), await store.list(), undefined];
void keep;
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'workflows-consumer.ts'], consumer);
  await writeFile(join(consumer, 'archil-consumer.ts'), `import { openDurableRun, type RunRef } from '@parcha/pi-durable-disk';
import { openRunLease } from '@parcha/pi-durable-disk/lease';
const durable: [typeof openDurableRun, typeof openRunLease, RunRef | undefined] = [openDurableRun, openRunLease, undefined];
// @ts-expect-error a run reference names its disk.
const incomplete: RunRef = { region: 'aws-us-east-1', id: 'r1' };
void [durable, incomplete];
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'archil-consumer.ts'], consumer);
  await writeFile(join(consumer, 'browser-consumer.ts'), `import { BROWSER_TOOLS, type BrowserPolicy } from '@parcha/pi-browser';
import { createBrowserExtension } from '@parcha/pi-browser/coding-agent';
import { FakeBackend } from '@parcha/pi-browser/testing';
const browser: [typeof BROWSER_TOOLS, typeof createBrowserExtension, typeof FakeBackend, BrowserPolicy | undefined] = [BROWSER_TOOLS, createBrowserExtension, FakeBackend, undefined];
void browser;
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'browser-consumer.ts'], consumer);
  await writeFile(join(consumer, 'vision-consumer.ts'), `import { resolveLimits, type Limits, type VisionOptions } from '@parcha/pi-vision';
import { createVisionExtension, type VisionHandle } from '@parcha/pi-vision/durable';
import { fakeEyes } from '@parcha/pi-vision/testing';
const limits: Limits = resolveLimits(undefined, { requestBytes: 20 * 1024 * 1024 });
const vision: [typeof createVisionExtension, typeof fakeEyes, VisionHandle | undefined] = [createVisionExtension, fakeEyes, undefined];
// @ts-expect-error a host's options name where looks are filed.
const unfiled: VisionOptions = { scope: (id: string) => ({ label: id, deriveDir: 'media' }) };
void [limits, vision, unfiled];
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'vision-consumer.ts'], consumer);
  await writeFile(join(consumer, 'transport-consumer.ts'), `import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { parseTransportConfig, type Box, type BoxProvider, type Transport, type TransportConfig, type TransportHost } from '@parcha/pi-transport';
${boxProviders.map(name => `import { ${name}Boxes } from '@parcha/pi-transport/box/${name}';`).join('\n')}
import { moveWorkspace, sealStore, type Seal } from '@parcha/pi-transport/home';
import { boxEnv, transport as openTransport } from '@parcha/pi-transport/hands';
const providers: [${boxProviders.map(name => `(...options: Parameters<typeof ${name}Boxes>) => BoxProvider`).join(', ')}] = [${boxProviders.map(name => `${name}Boxes`).join(', ')}];
const transport: [typeof parseTransportConfig, Box | undefined, typeof moveWorkspace, typeof sealStore, Seal | undefined] = [parseTransportConfig, undefined, moveWorkspace, sealStore, undefined];
// What a host hands to pi's Harness as a conversation's environment.
const hands = (box: Box): ExecutionEnv => boxEnv(box);
// The router: a Harness's env from a parsed config and what the host passes.
const routed = (config: TransportConfig, host: TransportHost): Transport => openTransport(config, host);
void [providers, transport, hands, routed];
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'transport-consumer.ts'], consumer);
  await writeFile(join(consumer, 'agent-consumer.ts'), `import { carryBack, createAgentHome, durableProfileStore, runPaths, startRun, type AgentHome, type CarryBack, type ProfileStore, type RunStart } from '@parcha/pi-durable-agent';
// A host's run: start it from the agent home, hand its browser the run store's profiles, carry it back.
const oneRun = async (home: AgentHome, harness: Parameters<typeof durableProfileStore>[0]): Promise<CarryBack> => {
  const started: RunStart = await startRun(home, { host: 'consumer' });
  const profiles: ProfileStore = durableProfileStore(harness);
  void [profiles, runPaths(home, started.runId).dir];
  return carryBack(home, started, { outcome: 'completed' });
};
void [oneRun, createAgentHome];
`);
  await writeFile(join(consumer, 'agent-export-consumer.ts'), `import { EXPORTABLE_KINDS, projectForExport, SECRET_KINDS } from '@parcha/pi-durable-agent/export';
// An exporter's view: the two lists and one document as it may leave the home, from the subpath that loads nothing else.
const kept: readonly string[] = EXPORTABLE_KINDS;
const secret: readonly string[] = SECRET_KINDS;
void [kept, secret, projectForExport('agent.runs', { path: 'runs/r1', host: 'h', startedAt: '' })];
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'agent-consumer.ts', 'agent-export-consumer.ts'], consumer);
  receipt.checks.push('Installed ESM imports, core execution, fake Jev/Pi adapters, and strict TypeScript consumer compilation passed.');
  await rm(join(receiptDir, 'packages'), { recursive: true, force: true });
  await mkdir(join(receiptDir, 'packages'), { recursive: true });
  for (const tarball of tarballs) await cp(tarball, join(receiptDir, 'packages', tarball.split('/').at(-1)));
  receipt.status = 'passed';
  console.log('Clean consumer execution, declarations, and dependency audit passed. Receipt: .release/verification.json');
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error instanceof Error ? error.message : 'Unknown verification failure';
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeReceipt();
  await rm(temporary, { recursive: true, force: true });
}
