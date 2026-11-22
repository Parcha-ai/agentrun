// Whether an image on GHCR can be pulled with no credentials (ghcr-published.mjs), with GHCR stubbed: the function the
// Render walk asks, and the command the release's box job runs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { anonymousPull, imagePublished } from './ghcr-published.mjs';

const exec = promisify(execFile);

test("the check asks GHCR as an anonymous pull does: true when it has the tag, false on its 404, undefined when it can't tell", async () => {
  const calls = [];
  const ghcr = (manifest) => async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), accept: new Headers(init.headers).get('accept') });
    if (url.startsWith('https://ghcr.io/token?')) return Response.json({ token: 'anon' });
    if (manifest instanceof Error) throw manifest;
    return new Response(null, { status: manifest });
  };
  assert.equal(await imagePublished('ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.49', ghcr(200)), true);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth]), [
    ['GET', 'https://ghcr.io/token?scope=repository:parcha-ai/agentrun-server:pull', null],
    ['HEAD', 'https://ghcr.io/v2/parcha-ai/agentrun-server/manifests/v0.1.0-beta.49', 'Bearer anon'],
  ]);
  assert.match(calls[1].accept, /application\/vnd\.oci\.image\.index\.v1\+json/, 'a multi-platform image is an index: asked for by that type');
  assert.match(calls[1].accept, /application\/vnd\.oci\.image\.manifest\.v1\+json/, 'a single-platform one a manifest');
  assert.equal(await imagePublished('ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.99', ghcr(404)), false);
  // Any other answer, or none, is not "not published".
  for (const answer of [401, 429, 500, new TypeError('fetch failed')]) {
    assert.equal(await imagePublished('ghcr.io/parcha-ai/agentrun-server:beta', ghcr(answer)), undefined, String(answer));
  }
  assert.match((await anonymousPull('ghcr.io/parcha-ai/agentrun-server:beta', ghcr(new TypeError('fetch failed')))).reason, /could not be asked: fetch failed/);
  calls.length = 0;
  for (const ref of ['docker.io/library/nginx:1', 'ghcr.io/parcha-ai/agentrun-server@sha256:' + 'a'.repeat(64), 'ghcr.io/parcha-ai/agentrun-server', undefined]) {
    assert.equal(await imagePublished(ref, ghcr(200)), undefined, String(ref));
  }
  assert.equal(calls.length, 0, "a reference it can't ask GHCR about sends nothing");
});

test('as a command: exit 0 when an anonymous pull finds the image, 1 otherwise, with what GHCR answered on stderr', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ghcr-published-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./ghcr-published.mjs', import.meta.url));
  for (const [status, code] of [[200, 0], [404, 1], [401, 1]]) {
    const stub = join(dir, `stub-${status}.mjs`);
    await writeFile(stub, `globalThis.fetch = async (url) => String(url).startsWith('https://ghcr.io/token?') ? Response.json({ token: 'anon' }) : new Response(null, { status: ${status} });\n`);
    const run = await exec(process.execPath, ['--import', stub, script, 'ghcr.io/parcha-ai/agentrun-box:0123456789ab']).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr }));
    assert.equal(run.code, code, `HTTP ${status}`);
    if (code) assert.match(run.stderr, new RegExp(`ghcr\\.io/parcha-ai/agentrun-box:0123456789ab: HTTP ${status} to an anonymous pull`));
  }
  const bad = await exec(process.execPath, [script, 'docker.io/library/nginx:1']).then(() => ({ code: 0 }), (e) => ({ code: e.code, stderr: e.stderr }));
  assert.deepEqual([bad.code, /is not a ghcr\.io\/<repo>:<tag> reference/.test(bad.stderr)], [1, true]);
});
