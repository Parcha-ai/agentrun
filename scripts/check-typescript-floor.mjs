#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
let compiler;
const fixture = join(root, '.release/typescript-floor.ts');
try {
  await mkdir(join(root, '.release'), { recursive: true });
  await writeFile(join(root, '.release/typescript-floor.json'), JSON.stringify({ status: 'running', typescript: '5.4.5', node: process.version }) + '\n');
  compiler = await mkdtemp(join(tmpdir(), 'agentrun-ts-floor-'));
  await rm(join(root, '.release/typescript-floor-diagnostics.txt'), { force: true });
  await writeFile(fixture, `import { z } from 'zod';
import {defineWorkflow,runTypedWorkflow} from '../packages/dsl/dist/index.js';
import {createJevRunner,type JevOptions} from '../packages/jev/dist/index.js';
import {createPiRunner,type PiRunnerOptions} from '../packages/pi/dist/index.js';
const workflow=defineWorkflow({name:'floor',schemas:{Input:z.strictObject({text:z.string()}),Output:z.strictObject({text:z.string()})},input:'Input',output:{schema:'Output',path:'result'},steps:[{node:'code',label:'copy',code:'s=>({result:{text:s.text}})'}]});
async function consumer(jev:JevOptions,pi:PiRunnerOptions){
 const result=await runTypedWorkflow(workflow,{text:'typed'},{runJudge:createJevRunner(jev),runNode:createPiRunner(pi)});
 if(result.status==='complete'){const text:string=result.output.text;void text;}
 // @ts-expect-error input must keep its inferred string type.
 await runTypedWorkflow(workflow,{text:42},{});
}
void consumer;\n`);
  await exec('npm', ['install', '--prefix', compiler, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', 'typescript@5.4.5'], { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const result = await exec(process.execPath, [join(compiler, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  await writeFile(join(root, '.release/typescript-floor.json'), JSON.stringify({ status: 'passed', typescript: '5.4.5', node: process.version }, null, 2) + '\n');
  console.log('All package declarations and inferred boundary contracts compile with TypeScript 5.4.5.');
} catch (error) {
  await writeFile(join(root, '.release/typescript-floor.json'), JSON.stringify({ status: 'failed', typescript: '5.4.5', node: process.version }) + '\n');
  await writeFile(join(root, '.release/typescript-floor-diagnostics.txt'), String(error.stdout || error.stderr || error.message));
  console.error('TypeScript floor verification failed; see .release/typescript-floor-diagnostics.txt');
  process.exitCode = 1;
} finally { if (compiler) await rm(compiler, { recursive: true, force: true }); }
