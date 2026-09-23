#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
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

try {
  const packageDirectories = ['dsl', 'jev', 'pi'];
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
      assert.ok(name.endsWith('/') || /^package\/(?:package\.json|README(?:\.md)?|LICENSE(?:\.txt|\.md)?|NOTICE(?:\.txt|\.md)?|dist\/.+|schema\/.+|skills\/.+)$/.test(name), `File outside the public package allowlist: ${name}`);
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
      for (const [kind, pattern] of forbid) assert.ok(!pattern.test(content) && !pattern.test(decoded), `${kind} found in ${manifest.name}/${name}; content omitted`);
      if (name.endsWith('.js') || name.endsWith('.d.ts')) {
        const imports = [...content.matchAll(/(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
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
    console.log(`Packed and inspected ${manifest.name}@${manifest.version} (${names.length} files)`);
  }
  receipt.checks.push('Archive paths, file allowlist, heuristic secret scan, and dependency boundary inspection passed.');
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'agentrun-clean-consumer', version: '1.0.0', private: true, type: 'module' }));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...tarballs], consumer);
  const typescript = await json(join(root, 'node_modules', 'typescript', 'package.json'));
  const nodeTypes = await json(join(root, 'node_modules', '@types', 'node', 'package.json'));
  const zod = await json(join(root, 'node_modules', 'zod', 'package.json'));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact', `typescript@${typescript.version}`, `@types/node@${nodeTypes.version}`, `zod@${zod.version}`], consumer);
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
  await writeFile(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow, defineWorkflow, runTypedWorkflow, inspectWorkflow, formatWorkflowTree } from '@parcha/agentrun-dsl';
import { z } from 'zod';
import { supportTriage } from '@parcha/agentrun-dsl/demo';
import { readFile } from 'node:fs/promises';
import { createJevRunner } from '@parcha/agentrun-jev';
import { createPiRunner, authorWorkflow } from '@parcha/agentrun-pi';
assert.equal(validateWorkflow(supportTriage).ok,true);
const schema=JSON.parse(await readFile(new URL(import.meta.resolve('@parcha/agentrun-dsl/schema')),'utf8'));
assert.equal(schema.$id,'https://agentrun.ai/schema/v2/workflow.schema.json');
const workflow = { v:2, name:'consumer', schemas:{Result:{type:'object',properties:{total:{type:'number'}},required:['total'],additionalProperties:false}},output:{schemaId:'Result',path:'result'},root:{node:'code',label:'add',code:'s => ({result:{total:s.left+s.right}})'}};
assert.equal(validateWorkflow(workflow).ok,true);
assert.deepEqual((await runWorkflow(workflow,{left:2,right:3},{})).output,{total:5});
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
console.log(JSON.stringify({core:true,jev:true,pi:true,network:'prohibited'}));
`);
  const smoke = JSON.parse((await offlineNode(['smoke.mjs'])).stdout);
  assert.deepEqual(smoke, { core: true, jev: true, pi: true, network: 'prohibited' });
  receipt.runtimeSmoke = smoke;
  await cp(join(root, 'scripts/verify-pi-install.mjs'), join(consumer, 'verify-pi-install.mjs'));
  receipt.piExtension = JSON.parse((await offlineNode(['verify-pi-install.mjs'])).stdout);
  receipt.checks.push('Packed Pi package installed and discovered by native Pi package manager/resource loader; skill and complete/escalated demos passed offline.');
  const auditRun = await run('npm', ['audit', '--omit=dev', '--json'], consumer, true);
  const audit = JSON.parse(auditRun.stdout);
  await writeFile(join(receiptDir, 'npm-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  assert.ok(audit.metadata?.vulnerabilities, 'npm audit could not produce a vulnerability report');
  receipt.audit = { vulnerabilities: audit.metadata.vulnerabilities, exitCode: auditRun.exitCode };
  assert.equal(audit.metadata.vulnerabilities.high + audit.metadata.vulnerabilities.critical, 0, 'Production dependencies have high or critical advisories; see .release/npm-audit.json');
  receipt.checks.push('Production dependency audit contains no high or critical advisories.');
  await writeFile(join(consumer, 'consumer.ts'), `import { runWorkflow, desugarWorkflow, defineWorkflow, runTypedWorkflow, type Workflow, type WorkflowDeps, type Predicate, type CallPredicate } from '@parcha/agentrun-dsl';
import { z } from 'zod';
import { createJevRunner, type JevOptions } from '@parcha/agentrun-jev';
import { createPiRunner, authorWorkflow, type PiRunnerOptions, type AuthorWorkflowOptions } from '@parcha/agentrun-pi';
const jevOptions: JevOptions = {client:{async systemOne(){return {answers:{ok:{type:'noul',noul:1}}};}}};
const deps: WorkflowDeps = { runJudge: createJevRunner(jevOptions) };
const workflow: Workflow = {v:2,name:'typed',schemas:{Result:{type:'object'}},output:{schemaId:'Result'},root:{node:'chain',steps:[]}};
async function useAll(pi: PiRunnerOptions, author: AuthorWorkflowOptions) {
  const result = await runWorkflow(workflow,{}, {...deps,runNode:createPiRunner(pi)});
  const candidate = await authorWorkflow(author);
  return [result.status,candidate.workflow.name];
}
void useAll;
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
