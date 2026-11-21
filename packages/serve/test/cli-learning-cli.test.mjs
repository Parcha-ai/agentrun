import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { learningMain } from '../dist/cli-learning/cli.js';
import { connectionFile } from '../dist/cli-learning/state.js';
import { runCliLearningHook } from '../dist/cli-learning/hook.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-learning-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), data = join(root, 'private-data');
  await mkdir(project); await mkdir(data);
  await writeFile(join(data, '.token'), 'fake-local-owner-key');
  const stdout = [], stderr = [], requests = [];
  const connection = { connection_id: 'test-connection', agent_id: 'test-agent', token: 'fake-connection-secret', active: true };
  const io = {
    stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), command: ['node', '/opt/agentrun/cli.js'],
    fetch: async (url, init) => {
      requests.push({ url: String(url), ...init });
      if (init.method === 'POST') return Response.json(connection);
      if (init.method === 'GET') return Response.json({ connections: [connection] });
      return Response.json({ ...connection, active: false });
    },
  };
  const args = (operation) => [operation, '--project', project, '--runtime', 'codex', '--data', data, '--url', 'http://127.0.0.1:7340'];
  return { project, data, stdout, stderr, requests, io, args, privateFile: connectionFile(data, 'codex', project) };
}

test('connect keeps scoped credentials private, reports honest status, and disconnect revokes', async (t) => {
  const f = await fixture(t);
  assert.equal(await learningMain(f.args('connect'), f.io), 0);
  const result = JSON.parse(f.stdout.at(-1));
  assert.equal(result.configured, true);
  assert.equal(result.activation, 'unverified');
  assert.equal(result.connection_id, 'test-connection');
  assert.equal(JSON.stringify(f.stdout).includes('fake-connection-secret'), false);
  assert.equal((await stat(f.privateFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(f.privateFile, 'utf8')).token, 'fake-connection-secret');
  assert.equal((await readFile(join(f.project, '.codex/hooks.json'), 'utf8')).includes('fake-connection-secret'), false);
  assert.deepEqual(JSON.parse(f.requests[0].body), { project: f.project, runtime: 'codex' });
  assert.equal(await learningMain(f.args('connect'), f.io), 0);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1, 'idempotent connect must not issue another credential');
  assert.equal(await learningMain(f.args('status'), f.io), 0);
  assert.deepEqual(JSON.parse(f.stdout.at(-1)).server, { reachable: true, enrolled: true, active: true });
  assert.equal(await learningMain(f.args('disconnect'), f.io), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).revoked, true);
  assert.equal(f.requests.at(-1).method, 'DELETE');
  await assert.rejects(readFile(f.privateFile), { code: 'ENOENT' });
});

test('failed installation revokes enrollment and deletes its private connection', async (t) => {
  const f = await fixture(t);
  const original = f.io.fetch;
  f.io.fetch = async (url, init) => {
    const response = await original(url, init);
    if (init.method === 'POST') {
      await mkdir(join(f.project, '.codex'));
      await writeFile(join(f.project, '.codex/hooks.json'), '{ invalid');
    }
    return response;
  };
  assert.equal(await learningMain(f.args('connect'), f.io), 2);
  assert.equal(f.requests.at(-1).method, 'DELETE');
  await assert.rejects(readFile(f.privateFile), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.project, '.codex/hooks.json'), 'utf8'), '{ invalid');
  assert.equal(JSON.stringify(f.stderr).includes('fake-connection-secret'), false);
});

test('offline disconnect removes hooks but retains revocation receipt for retry', async (t) => {
  const f = await fixture(t);
  await learningMain(f.args('connect'), f.io);
  const workingFetch = f.io.fetch;
  f.io.fetch = async () => { throw new Error('offline'); };
  assert.equal(await learningMain(f.args('disconnect'), f.io), 1);
  assert.equal(JSON.parse(f.stdout.at(-1)).revoked, false);
  assert.deepEqual(JSON.parse(await readFile(join(f.project, '.codex/hooks.json'), 'utf8')), {});
  await stat(f.privateFile);
  f.io.fetch = workingFetch;
  const posts = f.requests.filter(request => request.method === 'POST').length;
  const sessions = join(f.data, 'cli-learning', 'sessions');
  const journalFiles = () => readdir(sessions, { recursive: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const before = await journalFiles();
  await runCliLearningHook({ runtime: 'codex', project: f.project, dataDir: f.data, url: 'http://127.0.0.1:7340' }, {
    hook_event_name: 'UserPromptSubmit', session_id: 'still-loaded-session', turn_id: 'after-disconnect',
    cwd: f.project, prompt: 'This task was submitted after disconnecting locally.',
  }, { env: {}, fetch: workingFetch, snapshot: async () => ({ text: 'Fixture policy.', files: [], truncated: false }) });
  assert.equal(f.requests.filter(request => request.method === 'POST').length, posts, 'a loaded hook must not upload after offline disconnect');
  assert.deepEqual(await journalFiles(), before, 'a loaded hook must not save new task data after offline disconnect');
  assert.notEqual(await learningMain(f.args('retry'), f.io), 0, 'pending server revocation keeps capture retry disabled');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, posts);
  assert.deepEqual(await journalFiles(), before);
  assert.equal(await learningMain(f.args('status'), f.io), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).connection.capture_enabled, false);
  assert.equal(JSON.parse(await readFile(f.privateFile, 'utf8')).revocation_pending, true);
  assert.equal(await learningMain(f.args('connect'), f.io), 2, 'reconnect must not silently re-enable a locally disconnected capture');
  assert.match(f.stderr.at(-1), /disconnect|revocation/i);
  assert.deepEqual(JSON.parse(await readFile(join(f.project, '.codex/hooks.json'), 'utf8')), {});
  assert.equal(await learningMain(f.args('disconnect'), f.io), 0);
  assert.equal(f.requests.at(-1).method, 'DELETE', 'the retained credential is usable only to finish server revocation');
  await assert.rejects(readFile(f.privateFile), { code: 'ENOENT' });
});

test('hook worker fails open with no model context on malformed or oversized stdin', async (t) => {
  const f = await fixture(t);
  for (const input of ['invalid', 'x'.repeat(1_048_577)]) {
    const before = f.stdout.length;
    f.io.stdin = (async function* () { yield input; })();
    assert.equal(await learningMain(f.args('hook'), f.io), 0);
    assert.equal(f.stdout.length, before);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.stderr.length, 2);
});

test('rejects credentials under the source project before enrollment', async (t) => {
  const f = await fixture(t);
  const args = f.args('connect');
  args[args.indexOf('--data') + 1] = join(f.project, 'server-data');
  assert.equal(await learningMain(args, f.io), 2);
  assert.equal(f.requests.length, 0);
  assert.match(f.stderr.at(-1), /outside the project/);
});

for (const state of ['revoked', 'missing', 'offline']) {
  test(`connect refuses a saved ${state} enrollment without claiming activation`, async (t) => {
    const f = await fixture(t);
    assert.equal(await learningMain(f.args('connect'), f.io), 0);
    const before = await readFile(join(f.project, '.codex/hooks.json'), 'utf8');
    const count = f.stdout.length;
    f.io.fetch = async () => {
      if (state === 'offline') throw new Error('offline');
      return Response.json({ connections: state === 'missing' ? [] : [{ connection_id: 'test-connection', active: false }] });
    };
    assert.equal(await learningMain(f.args('connect'), f.io), 2);
    assert.equal(f.stdout.length, count);
    assert.match(f.stderr.at(-1), /verif|disconnect/i);
    assert.equal(await readFile(join(f.project, '.codex/hooks.json'), 'utf8'), before);
    await stat(f.privateFile);
  });
}

test('a connection command recovers a lock left by a killed owner',async t=>{
 const f=await fixture(t);
 const child=spawn(process.execPath,['--input-type=module','-e',`
  const { learningMain }=await import(${JSON.stringify(new URL('../dist/cli-learning/cli.js',import.meta.url).href)});
  await learningMain(${JSON.stringify(f.args('connect'))},{
   stdout:()=>{},stderr:()=>{},command:['node','/opt/agentrun/cli.js'],
   fetch:async()=>{process.stdout.write('operation-started\\n');return new Promise(()=>setInterval(()=>{},1000));},
  });
 `],{stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));
 const exited=once(child,'exit');
 const [ready]=await once(child.stdout,'data',{signal:AbortSignal.timeout(5000)});
 assert.match(String(ready),/operation-started/);
 child.kill('SIGKILL');await exited;
 assert.equal(await learningMain(f.args('connect'),f.io),0,'a dead lock owner must not block connection changes forever');
 assert.equal(f.requests.filter(request=>request.method==='POST').length,1);
 await assert.rejects(readFile(`${f.privateFile}.lock`),{code:'ENOENT'});
});

test('an old empty connection lock is recovered while a fresh incomplete lock stays protected',async t=>{
 const f=await fixture(t),lock=`${f.privateFile}.lock`;
 await mkdir(dirname(f.privateFile),{recursive:true});
 await writeFile(lock,'',{mode:0o600});
 assert.equal(await learningMain(f.args('connect'),f.io),2);
 assert.equal(f.requests.length,0,'a fresh incomplete owner record must not be stolen');
 const before=new Date(Date.now()-60_000);await utimes(lock,before,before);
 assert.equal(await learningMain(f.args('connect'),f.io),0,'legacy empty locks abandoned by a crash become recoverable');
 await assert.rejects(readFile(lock),{code:'ENOENT'});
});

test('a live connection owner excludes a concurrent command until it releases the lock',async t=>{
 const f=await fixture(t),original=f.io.fetch;
 let release,started;
 const gate=new Promise(resolve=>{release=resolve;});
 const entered=new Promise(resolve=>{started=resolve;});
 f.io.fetch=async(url,request)=>{if(request.method==='POST'){started();await gate;}return original(url,request);};
 const first=learningMain(f.args('connect'),f.io);
 try{
  await entered;
  assert.equal(await learningMain(f.args('disconnect'),f.io),2);
  assert.match(f.stderr.at(-1),/in progress/);
  assert.equal(f.requests.length,0,'the competing command never reaches the server');
 }finally{release();}
 assert.equal(await first,0);
 assert.equal(await learningMain(f.args('disconnect'),f.io),0);
});
