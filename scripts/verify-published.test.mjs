import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPublished, waitForRegistryVersions, registryBackoffMs, PACKUMENT_ACCEPT } from './verify-published.mjs';
import { releasePackageNames, releasePackages } from './release-preflight.mjs';

const bytes = Buffer.from('verified package fixture bytes');
const version = '0.1.0-beta.1';
const packages = releasePackages.map(directory => ({ directory, name: releasePackageNames[directory], version,
  sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }));
const metadata = { name: packages[0].name, version, dist: { integrity: packages[0].integrity, tarball: 'https://registry.npmjs.org/example.tgz' } };
const wait = async () => {};
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-published-test-'));
  try {
    await mkdir(join(root, '.release'));
    await writeFile(join(root, '.release/release-plan.json'), JSON.stringify({ status: 'passed', tag: `v${version}`, registry: 'https://registry.npmjs.org/', packages }));
    await writeFile(join(root, '.release/published-dsl.json'), JSON.stringify({ status: 'passed', stale: true }));
    await fn(root, async () => JSON.parse(await readFile(join(root, '.release/published-dsl.json'), 'utf8')));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const found = async url => String(url).endsWith('.tgz') ? new Response(bytes) : Response.json(metadata);

test('partial release can resume only when the existing version matches exact verified bytes', () => fixture(async (root, receipt) => {
  const result = await verifyPublished(root, 'dsl', { allowAbsent: true, fetchImpl: found, wait });
  assert.equal(result.status, 'passed');
  assert.equal(result.packages[0].sha256, packages[0].sha256);
  assert.equal((await receipt()).stale, undefined);
}));
test('only an authoritative 404 marks a version absent', () => fixture(async (root, receipt) => {
  let calls = 0;
  const result = await verifyPublished(root, 'dsl', { allowAbsent: true, fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); }, wait });
  assert.equal(result.status, 'absent');
  assert.equal(calls, 1);
  assert.equal((await receipt()).status, 'absent');
}));
test('mismatched published bytes cannot skip or permit a publish', () => fixture(async (root, receipt) => {
  await assert.rejects(verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async url => String(url).endsWith('.tgz') ? new Response('changed bytes') : Response.json(metadata),
  }), /differs from verified archive/);
  assert.equal((await receipt()).status, 'failed');
}));
test('transient metadata failure retries boundedly and cannot become absence', () => fixture(async (root, receipt) => {
  let calls = 0;
  await assert.rejects(verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async () => { calls++; return new Response(null, { status: 503 }); },
  }), /HTTP 503/);
  assert.equal(calls, 6);
  assert.equal((await receipt()).status, 'failed');
  calls = 0;
  const recovered = await verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async url => ++calls === 1 ? new Response(null, { status: 429 }) : found(url),
  });
  assert.equal(recovered.status, 'passed');
  assert.equal(calls, 3);
}));
test('permanent registry errors fail once and clear an old success receipt', () => fixture(async (root, receipt) => {
  let calls = 0;
  await assert.rejects(verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async () => { calls++; return new Response(null, { status: 403 }); },
  }), /HTTP 403/);
  assert.equal(calls, 1);
  assert.equal((await receipt()).status, 'failed');
}));
test('invalid release plans also replace prior successful verification evidence', () => fixture(async (root, receipt) => {
  await writeFile(join(root, '.release/release-plan.json'), '{}');
  await assert.rejects(verifyPublished(root, 'dsl', { fetchImpl: async () => { throw new Error('must not fetch'); }, wait }));
  assert.equal((await receipt()).status, 'failed');
}));

// The beta.11 run: npm showed the first package 16 minutes after it accepted it (published 16:35:56Z, visible 16:52:12Z), and the old
// wait, 61 tries 5 s apart, gave up at about 5 minutes with "Registry rejected @parcha/agentrun-dsl: HTTP 404". Beta.10 took about 5.
test('a version npm shows only 16 minutes after publishing is still verified', () => fixture(async (root, receipt) => {
  let metadataCalls = 0, tarballCalls = 0, waited = 0;
  const result = await verifyPublished(root, 'dsl', {
    now: () => waited,
    wait: async ms => { waited += ms; },
    fetchImpl: async url => {
      if (String(url).endsWith('.tgz')) return ++tarballCalls <= 7 ? new Response(null, { status: 404 }) : new Response(bytes);
      metadataCalls++;
      return waited < 976_000 ? new Response(null, { status: 404 }) : Response.json(metadata);
    },
  });
  assert.equal(result.status, 'passed');
  assert.ok(waited >= 976_000, `waited only ${waited} ms`);
  assert.ok(metadataCalls > 30 && metadataCalls < 60, `${metadataCalls} metadata requests for 16 minutes: backed off, not every 5 s`);
  assert.equal((await receipt()).packages[0].status, 'matched');
}));

test('the wait backs off from 5 s to 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(registryBackoffMs), [5000, 7500, 11250, 16875, 25313, 30000, 30000, 30000]);
});

test('a published version that never becomes visible fails after 20 minutes of backed-off retries', () => fixture(async (root, receipt) => {
  let calls = 0, waited = 0;
  const delays = [];
  await assert.rejects(verifyPublished(root, 'dsl', {
    wait: async ms => { waited += ms; delays.push(ms); },
    fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); },
  }), /HTTP 404/);
  assert.equal(calls, delays.length + 1);
  assert.deepEqual(delays.slice(0, 6), [5000, 7500, 11250, 16875, 25313, 30000]);
  assert.ok(delays.slice(5).every(ms => ms === 30_000));
  assert.ok(waited <= 20 * 60_000 && waited > 20 * 60_000 - 30_000, `waited ${waited} ms`);
  assert.ok(calls < 60, `${calls} requests in 20 minutes`);
  assert.equal((await receipt()).status, 'failed');
}));

test('post-publish authentication and integrity failures are not propagation delays', () => fixture(async (root, receipt) => {
  for (const response of [new Response(null, { status: 403 }), Response.json({ ...metadata, dist: { ...metadata.dist, integrity: 'wrong' } })]) {
    let calls = 0;
    await assert.rejects(verifyPublished(root, 'dsl', {
      wait: async () => { assert.fail('permanent failures must not wait'); },
      fetchImpl: async () => { calls++; return response; },
    }), /HTTP 403|integrity differs/);
    assert.equal(calls, 1);
    assert.equal((await receipt()).status, 'failed');
  }
}));

// The beta.4 run: every per-version document was visible, but `npm install` read an abbreviated
// packument that did not yet list pi, and failed with ETARGET a second after pi's check passed.
const registry = 'https://registry.npmjs.org/';
const packument = (pkg, listed) => Response.json({ name: pkg.name, versions: listed ? { [pkg.version]: {} } : {} });
const pkgFor = url => packages.find(pkg => String(url) === `${registry}${encodeURIComponent(pkg.name)}`);

test('the install waits until both packuments of every package list the release version', async () => {
  let polls = 0, waited = 0;
  const seen = new Set();
  const result = await waitForRegistryVersions(registry, packages, {
    now: () => waited,
    wait: async ms => { waited += ms; polls++; },
    fetchImpl: async (url, init) => {
      const pkg = pkgFor(url);
      assert.ok(pkg, `unexpected URL ${url}`);
      seen.add(init.headers.accept);
      // The full packument lists pi at once; the abbreviated one the installer reads lags 16 minutes, as npm did for beta.11's dsl.
      const lagging = pkg.directory === 'pi' && init.headers.accept === PACKUMENT_ACCEPT.abbreviated && waited < 976_000;
      return packument(pkg, !lagging);
    },
  });
  assert.equal(result.attempts, polls + 1);
  assert.ok(waited >= 976_000 && waited < 976_000 + 30_000, `waited ${waited} ms`);
  assert.deepEqual([...seen].sort(), Object.values(PACKUMENT_ACCEPT).sort());
});

test('a packument that never lists the version fails after the 20 minute budget and names what is missing', async () => {
  let waited = 0, calls = 0;
  await assert.rejects(waitForRegistryVersions(registry, packages, {
    wait: async ms => { waited += ms; },
    fetchImpl: async (url, init) => { calls++; const pkg = pkgFor(url); return pkg.directory === 'jev' && init.headers.accept === PACKUMENT_ACCEPT.full ? new Response(null, { status: 404 }) : packument(pkg, pkg.directory !== 'pi'); },
  }), /never listed @parcha\/agentrun-jev@0\.1\.0-beta\.1 \(full: HTTP 404\), @parcha\/agentrun-pi@0\.1\.0-beta\.1 \(full\), @parcha\/agentrun-pi@0\.1\.0-beta\.1 \(abbreviated\)/);
  assert.ok(waited <= 20 * 60_000 && waited > 20 * 60_000 - 30_000, `waited ${waited} ms`);
  const polls = calls / (2 * packages.length);
  assert.ok(Number.isInteger(polls) && polls > 30 && polls < 60, `${polls} polls in 20 minutes`);
});

test('packument authentication errors fail at once; network errors and 5xx are waited out', async () => {
  await assert.rejects(waitForRegistryVersions(registry, packages, {
    wait: async () => { assert.fail('a permanent failure must not wait'); },
    fetchImpl: async () => new Response(null, { status: 403 }),
  }), /full packument of @parcha\/agentrun-dsl: HTTP 403/);
  let calls = 0;
  const result = await waitForRegistryVersions(registry, packages, {
    wait: async () => {},
    fetchImpl: async url => { calls++; if (calls === 1) throw new Error('socket hang up'); if (calls === 2) return new Response(null, { status: 503 }); return packument(pkgFor(url), true); },
  });
  assert.deepEqual(result, { attempts: 2 });
});

test('an unreadable packument body is lag, not failure', async () => {
  let calls = 0;
  const result = await waitForRegistryVersions(registry, packages, {
    wait: async () => {},
    fetchImpl: async url => ++calls === 1 ? new Response('{"versions": {"0.1.0-bet', { headers: { 'content-type': 'application/json' } }) : packument(pkgFor(url), true),
  });
  assert.deepEqual(result, { attempts: 2 });
});

test('slow requests cannot stretch the wait past its wall budget', async () => {
  let clock = 0, polls = 0;
  await assert.rejects(waitForRegistryVersions(registry, packages, {
    now: () => clock,
    wait: async ms => { clock += ms; },
    // Every probe of a poll runs together and times out after 10 s: one poll costs 10 s, not 60 s.
    fetchImpl: async () => { if (++polls % (2 * packages.length) === 1) clock += 10_000; throw new Error('timeout'); },
  }), /never listed .*request failed/);
  assert.ok(clock <= 20 * 60_000 + 10_000, `waited ${clock} ms`);
  const polled = polls / (2 * packages.length);
  assert.ok(polled > 20 && polled < 60, `${polled} polls`);
});
