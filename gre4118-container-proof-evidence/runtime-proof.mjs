import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const execFile = promisify(execFileCallback);
const meta = JSON.parse(await readFile(process.argv[2], 'utf8'));
const dockerEnv = { ...process.env, DOCKER_CONFIG: meta.docker_config };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[name];
const docker = async (...args) => (await execFile('docker', args, { env: dockerEnv, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const facts = { commit: meta.commit, tag: meta.tag, container: meta.container, volume: meta.volume, checks: [], resources: [], cleanup: {} };
let createdVolume = false, createdContainer = false, token;
const checked = (name, evidence) => facts.checks.push({ name, verdict: 'PASS', ...evidence });
const json = async response => { const body = await response.json(); return { status: response.status, body }; };
try {
  const [image] = JSON.parse(await docker('image', 'inspect', meta.tag));
  facts.image = { id: image.Id, sizeBytes: image.Size, user: image.Config.User, created: image.Created };
  assert.equal(image.Config.User, 'node');
  await docker('volume', 'create', '--label', `gre4118.proof=${meta.commit}`, meta.volume); createdVolume = true;
  const id = await docker('run', '--detach', '--name', meta.container, '--label', `gre4118.proof=${meta.commit}`, '--publish', '127.0.0.1::7340', '--mount', `type=volume,source=${meta.volume},target=/data`, '--env', 'AGENTRUN_ACCOUNTS=1', meta.tag, '--data', '/data', '--listen', '0.0.0.0', '--port', '7340', '--drain-timeout', '2s', '--faux', '/opt/agentrun/packages/serve/test/fixtures/faux-model.mjs');
  createdContainer = true; facts.containerId = id;
  const [container] = JSON.parse(await docker('inspect', meta.container));
  const binding = container.NetworkSettings.Ports['7340/tcp'];
  assert.equal(binding.length, 1); assert.equal(binding[0].HostIp, '127.0.0.1');
  const origin = `http://127.0.0.1:${binding[0].HostPort}`; facts.origin = origin;
  checked('loopback-only publication and isolated data', { binding, imageUser: container.Config.User, dataVolume: meta.volume });
  const deadline = Date.now() + 60_000;
  let health;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${origin}/v2/health`, { signal: AbortSignal.timeout(3000) }); if (response.ok) { health = await json(response); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal(health?.status, 200); assert.equal(health.body.status, 'ok');
  checked('health', health);
  token = await docker('exec', meta.container, 'cat', '/data/.token'); assert.ok(token.length >= 32);
  const auth = { authorization: `Bearer ${token}` };
  const unauth = await json(await fetch(`${origin}/v2/agents`));
  assert.equal(unauth.status, 401); assert.equal(unauth.body.error.code, 'unauthenticated');
  const wrong = await json(await fetch(`${origin}/v2/agents`, { headers: { authorization: 'Bearer incorrect-container-test-token-0000' } }));
  assert.equal(wrong.status, 401);
  checked('unauthorized data denied', { missing: unauth, wrong: { status: wrong.status, code: wrong.body.error.code } });
  const caps = await json(await fetch(`${origin}/v2/capabilities`));
  assert.equal(caps.status, 200); assert.ok(caps.body.harnesses.some(h => h.id === 'pi' && h.available));
  checked('native capabilities', { status: caps.status, contract: caps.body.contract, server: caps.body.server, harnesses: caps.body.harnesses.map(({id,available}) => ({id,available})) });
  const document = await fetch(`${origin}/`); const html = await document.text(); assert.equal(document.status, 200);
  assert.ok(document.headers.get('content-security-policy').includes("script-src 'self'"));
  const scriptPath = /src="\.\/(assets\/[^\"]+\.js)"/.exec(html)?.[1];
  const stylePath = /href="\.\/(assets\/[^\"]+\.css)"/.exec(html)?.[1]; assert.ok(scriptPath && stylePath);
  const asset = await fetch(`${origin}/${scriptPath}`); const bytes = new Uint8Array(await asset.arrayBuffer()); assert.equal(asset.status, 200);
  const style = await fetch(`${origin}/${stylePath}`); const css = await style.text(); assert.equal(style.status, 200); assert.ok(css.includes('border-radius:12px'));
  const unlisted = await fetch(`${origin}/assets/not-in-this-build.js`); assert.equal(unlisted.status, 404);
  const jsSha256 = createHash('sha256').update(bytes).digest('hex');
  const cssSha256 = createHash('sha256').update(css).digest('hex');
  assert.equal(jsSha256, meta.expectedJsSha256, 'container serves the exact reviewed JavaScript');
  assert.equal(cssSha256, meta.expectedCssSha256, 'container serves the exact reviewed CSS');
  checked('standalone console index and exact built assets', { indexStatus: document.status, script: { path: scriptPath, status: asset.status, bytes: bytes.length, sha256: jsSha256 }, css: { path: stylePath, status: style.status, sha256: cssSha256 }, csp: document.headers.get('content-security-policy'), unlistedStatus: unlisted.status });
  const setup = await fetch(`${origin}/v2/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'synthetic-container-passphrase' }) });
  const setupBody = await setup.json(); assert.equal(setup.status, 201); assert.equal(setupBody.signed_in, true);
  const setCookie = setup.headers.get('set-cookie'); assert.ok(setCookie?.includes('HttpOnly')); assert.ok(setCookie?.includes('SameSite=Strict'));
  const cookie = setCookie.split(';')[0];
  const cookieRead = await fetch(`${origin}/v2/agents`, { headers: { cookie } }); assert.equal(cookieRead.status, 200);
  const crossOrigin = await fetch(`${origin}/v2/agents`, { method: 'POST', headers: { cookie, origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ definition: { id: 'must-not-create', name: 'must-not-create', instructions: 'Answer.', tools: [], skills: [] } }) });
  assert.equal(crossOrigin.status, 401);
  checked('owner bootstrap and cookie same-origin protection', { setupStatus: setup.status, signedIn: setupBody.signed_in, cookieReadStatus: cookieRead.status, cookieHttpOnly: true, cookieSameSiteStrict: true, crossOriginStatus: crossOrigin.status });
  const create = await fetch(`${origin}/v2/agents`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ definition: { id: 'container-proof', version: 1, name: 'Container proof', instructions: 'Answer the task.', tools: [], skills: [] } }) });
  const made = await create.json(); assert.equal(create.status, 201); facts.resources.push({ agentId: made.agent_id, revision: made.revision });
  const start = await fetch(`${origin}/v2/agents/${made.agent_id}/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'gre4118-container-proof-run-1' }, body: JSON.stringify({ input: { content: 'What is six times seven?' }, revision: made.revision }) });
  const started = await start.json(); assert.equal(start.status, 202); facts.resources.push({ runId: started.run_id });
  let after, final; const rows = new Map(); const runDeadline = Date.now() + 45_000;
  while (Date.now() < runDeadline) {
    const query = new URLSearchParams({ wait_ms: '2000', ...(after === undefined ? {} : { after: String(after) }) });
    const response = await fetch(`${origin}/v2/runs/${started.run_id}/timeline?${query}`, { headers: auth, signal: AbortSignal.timeout(5000) });
    const page = await response.json(); assert.equal(response.status, 200);
    if (page.reset) rows.clear(); for (const id of page.drop) rows.delete(id); for (const row of page.rows) rows.set(row.id, row);
    after = page.next_after; if (page.final && !page.has_more) { final = page; break; }
  }
  assert.equal(final?.status, 'completed');
  const read = await json(await fetch(`${origin}/v2/runs/${started.run_id}`, { headers: auth }));
  assert.equal(read.body.result.final_answer, 'The answer is 42.'); assert.equal(read.body.revision, made.revision);
  assert.equal([...rows.values()].filter(row => row.kind === 'user_message').length, 1);
  await docker('exec', meta.container, 'node', '--input-type=module', '-e', "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; for (const path of ['tone.wav', 'clip.webm']) writeFileSync(join(process.argv[1], path), Uint8Array.of(0,255,128,1,2));", `/data/runs/${started.run_id}/work`);
  const fileList = await json(await fetch(`${origin}/v2/runs/${started.run_id}/files`, { headers: auth }));
  assert.equal(fileList.status, 200);
  const media = [];
  for (const [path, type] of [['tone.wav', 'audio/wav'], ['clip.webm', 'video/webm']]) {
    assert.equal(fileList.body.files.find(file => file.path === path).content_type, type);
    const raw = await fetch(`${origin}/v2/runs/${started.run_id}/files/${path}`, { headers: auth });
    assert.equal(raw.status, 200); assert.equal(raw.headers.get('content-type'), type);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), Uint8Array.of(0,255,128,1,2));
    media.push({ path, type, status: raw.status, exactBytes: true, nosniff: true });
  }
  checked('real faux child process, persisted result and native media MIME', { createStatus: create.status, startStatus: start.status, agentId: made.agent_id, revision: made.revision, runId: started.run_id, timelineFinal: final.final, status: read.body.status, result: read.body.result, rowKinds: [...rows.values()].sort((a,b) => a.seq-b.seq).map(row => row.kind), media });
  const imageCheck = await docker('exec', meta.container, 'sh', '/opt/agentrun/packages/serve/docker/image-check.sh', '/opt/agentrun');
  checked('native image redistributable-dependency gate', { output: imageCheck });
  let logs = await docker('logs', meta.container);
  logs = logs.replaceAll(token, '<redacted-local-token>').replace(/ar_local_[A-Za-z0-9_-]+/g, '<redacted-local-token>');
  await writeFile(`${meta.root}/runtime.sanitized.log`, logs);
  facts.status = 'PASS';
} catch (error) {
  facts.status = 'FAIL'; facts.failure = String(error.stack ?? error);
  if (token) facts.failure = facts.failure.replaceAll(token, '<redacted-local-token>');
  process.exitCode = 1;
} finally {
  if (createdContainer && facts.status === 'FAIL') {
    try {
      const result = await execFile('docker', ['logs', meta.container], { env: dockerEnv, maxBuffer: 4 * 1024 * 1024 });
      let logs = result.stdout + result.stderr;
      if (token) logs = logs.replaceAll(token, '<redacted-local-token>');
      await writeFile(`${meta.root}/runtime.sanitized.log`, logs.replace(/ar_local_[A-Za-z0-9_-]+/g, '<redacted-local-token>'));
    } catch {}
  }
  if (createdContainer) {
    try { await docker('stop', '--time', '10', meta.container); facts.cleanup.containerStopped = true; } catch (e) { facts.cleanup.stopError = String(e.message); }
    try { await docker('rm', meta.container); facts.cleanup.containerRemoved = true; } catch (e) { facts.cleanup.removeError = String(e.message); }
  }
  if (createdVolume) {
    try { await docker('volume', 'rm', meta.volume); facts.cleanup.volumeRemoved = true; } catch (e) { facts.cleanup.volumeError = String(e.message); }
  }
  try {
    const containers = (await docker('container', 'ls', '--all', '--format', '{{.Names}}')).split('\n');
    const volumes = (await docker('volume', 'ls', '--format', '{{.Name}}')).split('\n');
    assert.equal(containers.includes(meta.container), false);
    assert.equal(volumes.includes(meta.volume), false);
    assert.equal(await docker('image', 'inspect', '--format', '{{.Id}}', meta.tag), facts.image.id);
    facts.cleanup.containerAbsentReadback = true;
    facts.cleanup.volumeAbsentReadback = true;
    facts.cleanup.imagePresentReadback = true;
  } catch (error) {
    facts.status = 'FAIL'; facts.cleanup.readbackError = String(error.message); process.exitCode = 1;
  }
  facts.cleanup.imageRetained = meta.tag;
  await writeFile(`${meta.root}/runtime-result.json`, JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ status: facts.status, imageId: facts.image?.id, checks: facts.checks.length, cleanup: facts.cleanup, failure: facts.failure }));
}
