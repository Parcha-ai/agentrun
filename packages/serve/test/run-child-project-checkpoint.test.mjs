// The held host boundary uses real immutable snapshots, placement, capture and store rows; no model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { heldFor } from '../dist/runner/run-child-host.js';
import { runProjectCheckpoint } from '../dist/runner/project-checkpoint.js';
import { launchBody } from '../dist/run-launch.js';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { commitSourceSnapshot } from '../dist/source-sync/snapshots.js';
import { sourceWorkspace, sourceSnapshotReader, openRunPlacement } from '../dist/source-sync/workspace.js';
import { projectPlacement } from '../dist/source-sync/projects.js';
import { beginSourceIO, requireSourceIOIdle, sourceIOPrefix } from '../dist/source-sync/io.js';
import { purgingKey } from '../dist/agent-delete.js';
import { localWorkspace } from '../dist/workspace/local.js';
import { runFolder, sourceSnapshotsKey, sourceRunControlKey } from '../dist/workspace/paths.js';
import { storeOn } from './store-helpers.mjs';

async function fixture(t, { sync = async () => {}, release = async () => {}, missingPlacement = false, rawComputer, auxiliary = false } = {}) {
  let side, workspace;
  t.after(() => side?.release());
  const { store, dir: data, clock } = await storeOn(t), sealKey = Buffer.alloc(32, 7);
  const options = { data, sealKey, env: {} }, bytes = Buffer.from('private authored fixture content\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const body = { version: 1, complete: true,
    source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/project', selector: { kind: 'project' } },
    entries: [{ path: 'project', role: 'project', type: 'directory', mode: 0o755, bytes: 0 },
      { path: 'project/state.txt', role: 'project', type: 'file', mode: 0o644, bytes: bytes.length, sha256 }],
    blobs: { [sha256]: bytes.toString('base64') }, instructions: { text: '', layers: [] }, skills: [],
    configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const snapshot = { ...body, digest: sourceSnapshotDigest(body) };
  await store.agents.create({ id: 'agent', name: 'Moved fixture' }, { id: 'base', kind: 'agentic', body: {
    instructions: 'Keep the project.', sourceSync: { id: 'a'.repeat(64), snapshot: snapshot.digest, project: snapshot.digest, configuration: 'b'.repeat(64) },
  } });
  const cache = await sourceWorkspace(store, 'agent', options);
  try { await commitSourceSnapshot(cache.workspace, snapshot); } finally { await cache.end(); }
  const placement = projectPlacement({ hold: ({ agentId }) => beginSourceIO(store, agentId, 'placement'),
    snapshots: agentId => sourceSnapshotReader(store, agentId, options), destination: input => openRunPlacement(store, input, options) });
  const revision = await store.agents.revision('base');
  const placed = await placement.place({ agentId: 'agent', runId: 'own-run', revision,
    launch: { input: { content: 'Work.' }, title: 'Work', place: { mode: 'runner' }, ...(auxiliary ? { audit: { of: 'served-run' } } : {}) } });
  await store.runs.create({ id: 'own-run', agentId: 'agent', revisionId: 'base', expectedCurrent: 'base' }, { body: launchBody(placed.launch) });
  await placed.admitted();
  const claim = await store.claim('own-run', 'fixture', { leaseMs: 60_000 });
  const secret = 'not-a-secret-' + 'held-project-fixture-key';
  side = heldFor({ ...options, store, env: { OPENAI_API_KEY: secret }, computerForClaim: async (_target, _store, options) => {
    workspace = options.workspace;
    return { syncProject: sync, release, ...(rawComputer ? { computer: rawComputer } : {}) };
  } },
    { claim, run: { agentId: 'agent', revisionId: 'base', signInHanded: null }, launch: missingPlacement ? { ...placed.launch, sourceProject: undefined } : placed.launch,
      revision, claimed: { OPENAI_API_KEY: secret }, signal: new AbortController().signal },
    text => text, () => {});
  assert.equal(typeof side.held.projectCheckpoint, 'function', 'isolated runs need a claim-bound host checkpoint capability');
  const computer = !missingPlacement ? await side.held.computer({ hadComputer: async () => false }) : undefined;
  return { store, side, clock, secret, claim, snapshot, computer, workspace, data, options, launch: placed.launch };
}

async function stageGitChange(f) {
  const git = async (...args) => {
    const result = await f.workspace.exec(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: 10_000, maxOutput: 64 * 1024,
    });
    assert.equal(result.code, 0, Buffer.from(result.stderr).toString());
    assert.equal(result.timedOut, false);
  };
  await git('init', '--quiet', '--initial-branch=main');
  await git('add', 'state.txt');
  await git('commit', '--quiet', '-m', 'Initial fixture');
  await f.workspace.write('state.txt', 'staged fixture edit\n');
  await git('add', 'state.txt');
}

const knownRefusals = {
  'staged Git index': stageGitChange,
  'held credential in an asset': f => f.workspace.write('state.txt', f.secret),
  'unsupported symbolic link': f => symlink('state.txt', join(runFolder(f.data, 'agent', 'own-run'), 'linked.txt')),
};
for (const [reason, arrange] of Object.entries(knownRefusals)) {
  test(`a settled ${reason} refusal releases ownership without publishing the rejected project`, { timeout: 30_000 }, async t => {
    let releases = 0;
    const f = await fixture(t, { release: async () => { releases++; } });
    await arrange(f);
    const receipt = await f.side.held.projectCheckpoint();
    assert.equal(receipt.status, 'uncertain', 'refusal must never become a publishable project candidate');
    assert.equal(receipt.stage, 'capture');
    assert.equal(JSON.stringify(receipt).includes(f.secret), false);
    assert.equal((await f.store.agents.get('agent')).currentRevision, 'base');
    assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1, 'resources remain owned until cleanup finishes');
    await f.side.release();
    assert.equal(releases, 1);
    assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), [], 'completed cleanup must not leave a separate permanent writer receipt');
    await f.store.agents.archive('agent', true); await f.store.settings.put(purgingKey('agent'), true);
    await requireSourceIOIdle(f.store, 'agent');
  });
}

test('a failed computer sync retains ownership after checkpoint cleanup', async t => {
  const f = await fixture(t, { sync: async () => { throw new Error('fixture lost sync response'); } });
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'sync');
  await f.side.release();
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'));
});

test('a refused project still retains ownership when its external cleanup fails', async t => {
  const f = await fixture(t, { release: async () => { throw new Error('fixture cleanup outcome unknown'); } });
  await f.workspace.write('state.txt', f.secret);
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'capture');
  await f.side.release();
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'));
});

test('a lost snapshot write response keeps ownership even when bytes reached storage', async t => {
  const f = await fixture(t);
  await f.workspace.write('state.txt', 'a changed project needs a new immutable blob\n');
  const prototype = Object.getPrototypeOf(localWorkspace(f.data)), write = prototype.write;
  const prefix = `disk/${sourceSnapshotsKey('agent')}/blobs/`;
  let written = false;
  t.mock.method(prototype, 'write', async function (path, bytes) {
    await write.call(this, path, bytes);
    if (path.startsWith(prefix)) { written = true; throw new Error('fixture lost storage acknowledgment'); }
  });
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(written, true, 'the immutable storage write actually happened before the response was lost');
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'commit');
  await f.side.release();
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'));
});

test('a timed-out capture command is not a settled validation refusal', async t => {
  const f = await fixture(t);
  const prototype = Object.getPrototypeOf(localWorkspace(f.data)), exec = prototype.exec;
  let interrupted = false;
  t.mock.method(prototype, 'exec', async function (argv, options) {
    const result = await exec.call(this, argv, options);
    if (argv[0] === 'find') { interrupted = true; return { ...result, timedOut: true }; }
    return result;
  });
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(interrupted, true);
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'capture');
  await f.side.release();
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'), 'a SnapshotError from failed execution is not proof that all backend activity settled');
});

for (const changed of ['bytes', 'metadata']) {
  test(`observed project ${changed} changing during capture retains ownership`, async t => {
    const f = await fixture(t);
    const prototype = Object.getPrototypeOf(localWorkspace(f.data)), read = prototype.read;
    let mutated = false;
    t.mock.method(prototype, 'read', async function (path, range) {
      if (path === 'state.txt' && !mutated) {
        mutated = true;
        await this.write(changed === 'bytes' ? 'state.txt' : 'arrived.txt', 'a writer changed the project after inventory\n');
      }
      return read.call(this, path, range);
    });
    const receipt = await f.side.held.projectCheckpoint();
    assert.equal(mutated, true, 'the live project changed after the capture inventory');
    assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'capture');
    await f.side.release();
    await assert.rejects(requireSourceIOIdle(f.store, 'agent'), 'an observed escaping writer remains unsafe even after scratch cleanup');
  });
}

for (const changed of ['privileged mode', 'symbolic link']) {
  test(`verification discovering a newly invalid ${changed} retains ownership`, async t => {
    const f = await fixture(t);
    const prototype = Object.getPrototypeOf(localWorkspace(f.data)), read = prototype.read;
    let mutated = false;
    t.mock.method(prototype, 'read', async function (path, range) {
      const body = await read.call(this, path, range);
      if (path === 'state.txt' && !mutated) {
        mutated = true;
        const absolute = join(runFolder(f.data, 'agent', 'own-run'), 'state.txt');
        if (changed === 'privileged mode') await chmod(absolute, 0o4755);
        else { await unlink(absolute); await symlink('missing.txt', absolute); }
      }
      return body;
    });
    const receipt = await f.side.held.projectCheckpoint();
    assert.equal(mutated, true, 'the initially valid inventory changed after its file was read');
    assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'capture');
    await f.side.release();
    await assert.rejects(requireSourceIOIdle(f.store, 'agent'), 'a policy error in verification is evidence of mutation, not a settled initial refusal');
  });
}

test('scratch cleanup losing its acknowledgment cannot release a known capture refusal', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await stageGitChange(f);
  const prototype = Object.getPrototypeOf(localWorkspace(f.data)), remove = prototype.remove;
  const prefix = `disk/${sourceRunControlKey('agent', 'own-run')}/capture-`;
  let removed = false;
  t.mock.method(prototype, 'remove', async function (path, options) {
    await remove.call(this, path, options);
    if (path.startsWith(prefix)) { removed = true; throw new Error('fixture lost scratch cleanup acknowledgment'); }
  });
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(removed, true, 'the scratch cleanup dispatched after the staged-index refusal');
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'capture');
  await f.side.release();
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'));
});

test('a direct checkpoint releases its own settled refusal without clearing the held host receipt', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await stageGitChange(f);
  const before = await f.store.settings.all({ prefix: sourceIOPrefix('agent') });
  assert.equal(before.length, 1);
  const direct = runProjectCheckpoint({ store: f.store, agentId: 'agent', claim: f.claim, launch: f.launch,
    tools: { workspace: f.workspace, settleProject: async () => [] }, computer: { syncProject: async () => {}, release: async () => {} },
    workspace: f.options, secrets: async () => [f.secret] });
  const receipt = await direct.capture(new AbortController().signal);
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'capture');
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), before, 'only the direct capture owns and clears its additional receipt');
  await f.side.release();
  await requireSourceIOIdle(f.store, 'agent');
});

test('host checkpoint refuses child-selected arguments before any snapshot write or synchronization', async t => {
  let syncs = 0;
  const f = await fixture(t, { sync: async () => { syncs++; } });
  const initial = await f.store.settings.all({ prefix: sourceIOPrefix('agent') });
  for (const args of [[{ runId: 'another-run' }], [undefined, { path: '/another-project' }], [() => {}]])
    await assert.rejects(async () => f.side.held.projectCheckpoint(...args));
  assert.equal(syncs, 0);
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), initial, 'invalid requests add no ownership or writes');
});

test('duplicate host checkpoint requests coalesce and return only the immutable receipt', { timeout: 30_000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(); let syncs = 0;
  const f = await fixture(t, { sync: async () => { syncs++; entered.resolve(); await finish.promise; } });
  const first = f.side.held.projectCheckpoint(new AbortController().signal);
  const second = f.side.held.projectCheckpoint(new AbortController().signal);
  try {
    await entered.promise;
    assert.equal(syncs, 1, 'one claim must not capture twice while the first request is pending');
  } finally { finish.resolve(); }
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 'candidate'); assert.deepEqual(two, one);
  assert.equal(one.runId, f.claim.runId); assert.equal(one.epoch, f.claim.epoch);
  assert.deepEqual(await f.side.held.projectCheckpoint(), one, 'completed requests return the same receipt');
  assert.equal(syncs, 1);
  const serialized = JSON.stringify(one);
  assert.equal(serialized.includes(f.secret), false);
  assert.equal(serialized.includes('private authored fixture content'), false);
  assert.equal('blobs' in one, false); assert.equal('entries' in one, false);
  assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1, 'host resources remain owned through release');
  await f.side.release();
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), []);
});

test('held release waits for the actual checkpoint operation after cancellation', { timeout: 30_000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(); let released = 0;
  const f = await fixture(t, { sync: async () => { entered.resolve(); await finish.promise; }, release: async () => { released++; } });
  const abort = new AbortController();
  const capture = f.side.held.projectCheckpoint(abort.signal).then(value => ({ value }), error => ({ error }));
  await entered.promise; abort.abort(new Error(f.secret));
  let ended = false; const closing = f.side.release().then(() => { ended = true; });
  try {
    await setImmediate();
    assert.equal(ended, false, 'abort does not prove the underlying sync or capture has settled');
    assert.equal(released, 0, 'do not release the actual computer beneath a pending checkpoint');
  } finally { finish.resolve(); }
  const answer = await capture; await closing;
  assert.notEqual(answer.value?.status, 'candidate', 'an aborted capture never publishes a stable project');
  assert.equal(JSON.stringify(answer).includes(f.secret), false, 'cancellation details never reach the checkpoint receipt');
  assert.equal(ended, true); assert.equal(released, 1);
});

test('a superseded claim cannot begin checkpoint work through its retained host capability', async t => {
  let syncs = 0; const f = await fixture(t, { sync: async () => { syncs++; } });
  const initial = await f.store.settings.all({ prefix: sourceIOPrefix('agent') });
  f.clock.now += 60_001;
  const next = await f.store.claim('own-run', 'replacement', { leaseMs: 60_000 });
  assert.ok(next.epoch > f.claim.epoch);
  const answer = await f.side.held.projectCheckpoint().then(value => ({ value }), error => ({ error }));
  assert.notEqual(answer.value?.status, 'candidate');
  assert.equal(syncs, 0, 'the old capability refuses before backend operations');
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), initial, 'refusal does not dispatch a new writer');
});

// The checkpoint's end sweeps the run folder's scratch only while projectOwns still finds this claim on the run's row:
// a claim superseded mid-capture shares that folder with its re-claimer, whose scratch the old end must leave.
for (const superseded of [false, true]) {
  test(`a checkpoint whose claim ${superseded ? 'is superseded mid-capture leaves' : 'still holds sweeps'} the run folder's scratch at its end`, { timeout: 30_000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const f = await fixture(t, { sync: async () => { entered.resolve(); await finish.promise; } });
    const scratch = join(runFolder(f.data, 'agent', 'own-run'), '.agentrun', 'tmp');
    const capture = f.side.held.projectCheckpoint().then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      // Written after settleProject's own sweep: only the end can remove it.
      await mkdir(scratch, { recursive: true }); await writeFile(join(scratch, 'later-claim.txt'), 'the re-claimer\'s scratch');
      if (superseded) {
        f.clock.now += 60_001;
        const next = await f.store.claim('own-run', 'replacement', { leaseMs: 60_000 });
        assert.ok(next.epoch > f.claim.epoch);
      }
    } finally { finish.resolve(); }
    const answer = await capture;
    if (superseded) {
      assert.notEqual(answer.value?.status, 'candidate', 'a superseded claim never publishes a project');
      assert.equal(await readFile(join(scratch, 'later-claim.txt'), 'utf8'), 'the re-claimer\'s scratch', 'projectOwns refused: the end leaves the scratch');
    } else {
      assert.equal(answer.value?.status, 'candidate');
      await assert.rejects(readFile(join(scratch, 'later-claim.txt')), { code: 'ENOENT' }, 'the claim still holds: the end sweeps its scratch');
    }
  });
}

test('host resources keep deletion fenced when a superseded child never reaches checkpoint', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1, 'ownership starts with writable host resources');
  f.clock.now += 60_001;
  const replacement = await f.store.claim('own-run', 'replacement', { leaseMs: 60_000 });
  const journal = f.store.journal(replacement);
  await commitWrites(journal, [{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
  const id = await journal.mintId(); journal.stage({ run: { state: 'ended' }, effect: id });
  await commitWrites(journal, [{ type: 'entry', value: { id, conversationId: 1, kind: 'agentrun.end', data: { state: 'ended' } } }], BACKGROUND_CONTEXT);
  await journal.close();
  assert.equal((await f.store.runs.get('own-run')).state, 'ended');
  await f.store.agents.archive('agent', true); await f.store.settings.put(purgingKey('agent'), true);
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'), /source.*operation|source.*writ/i);
  await f.side.release();
  await requireSourceIOIdle(f.store, 'agent');
});

test('a source-bound revision without its matching placement has no host capture authority', async t => {
  let syncs = 0; const f = await fixture(t, { missingPlacement: true, sync: async () => { syncs++; } });
  await assert.rejects(async () => f.side.held.projectCheckpoint());
  assert.equal(syncs, 0);
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), []);
});

test('a returned computer release closes checkpoint admission before its asynchronous cleanup', { timeout: 30_000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(); let syncs = 0;
  const f = await fixture(t, { sync: async () => { syncs++; }, release: async () => { entered.resolve(); await finish.promise; } });
  const release = f.computer.release();
  try {
    await entered.promise;
    assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1, 'pending cleanup remains an owned writer');
    await assert.rejects(async () => f.side.held.projectCheckpoint(), /releas|clean|clos/i);
    assert.equal(syncs, 0, 'capture never starts against resources already being relinquished');
  } finally { finish.resolve(); await release; }
});

test('an unresolved nested write prevents a checkpoint candidate and retains ownership after release', async t => {
  let syncs = 0;
  const f = await fixture(t, { sync: async () => { syncs++; }, rawComputer: { client: {
    call: async () => { throw new Error('fixture transport lost its write response'); },
  } } });
  await assert.rejects(f.computer.computer.client.call('files.write', { path: 'state.txt', content: 'not acknowledged' }));
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.stage, 'drain');
  assert.equal(syncs, 0, 'drained promises cannot prove the remote write completed');
  assert.equal(JSON.stringify(receipt).includes('fixture transport'), false);
  await f.side.release();
  assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1);
});

async function parkOwnedClaim(f) {
  const journal = f.store.journal(f.claim);
  await commitWrites(journal, [{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
  const id = await journal.mintId();
  journal.stage({ run: { state: 'parked' }, effect: id });
  await commitWrites(journal, [{ type: 'entry', value: { id, conversationId: 1, kind: 'agentrun.ask', data: { callId: 'not-dispatched' } } }], BACKGROUND_CONTEXT);
  await journal.close();
  const row = await f.store.runs.get(f.claim.runId);
  assert.equal(row.state, 'parked');
  assert.equal(row.epoch, f.claim.epoch);
  assert.equal(row.runner, f.claim.runner);
}

test('an auxiliary audit ending at approval settles its still-owned parked claim without publishing a project', async t => {
  let syncs = 0;
  const f = await fixture(t, { auxiliary: true, sync: async () => { syncs++; } });
  await parkOwnedClaim(f);
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'discarded', JSON.stringify(receipt));
  assert.equal(syncs, 1, 'the non-dispatched approval is no reason to skip actual project settlement');
  await f.side.release();
  await requireSourceIOIdle(f.store, 'agent');
});

test('a parked audit cannot dispatch new work through the held host', async t => {
  const f = await fixture(t, { auxiliary: true });
  await parkOwnedClaim(f);
  await assert.rejects(f.side.held.computer({ hadComputer: async () => false }), /claim/);
});

test('a normal parked run cannot request the auxiliary terminal-settlement exception', async t => {
  let syncs = 0;
  const f = await fixture(t, { sync: async () => { syncs++; } });
  await parkOwnedClaim(f);
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'uncertain');
  assert.equal(syncs, 0);
});

test('a parked audit with an unknown write outcome still cannot settle or clear ownership', async t => {
  let syncs = 0;
  const f = await fixture(t, { auxiliary: true, sync: async () => { syncs++; }, rawComputer: { client: {
    call: async () => { throw new Error('fixture write result lost'); },
  } } });
  await assert.rejects(f.computer.computer.client.call('files.write', { path: 'state.txt', content: 'unacknowledged' }));
  await parkOwnedClaim(f);
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'uncertain'); assert.equal(syncs, 0);
  await f.side.release();
  await assert.rejects(requireSourceIOIdle(f.store, 'agent'));
});

test('a parked audit cannot settle after the claim has been released', async t => {
  let syncs = 0;
  const f = await fixture(t, { auxiliary: true, sync: async () => { syncs++; } });
  await parkOwnedClaim(f);
  await f.side.release();
  await assert.rejects(async () => f.side.held.projectCheckpoint(), /released/);
  assert.equal(syncs, 0);
});

test('a parked audit cannot settle through its superseded claim even when the replacement is also parked', async t => {
  let syncs = 0;
  const f = await fixture(t, { auxiliary: true, sync: async () => { syncs++; } });
  await parkOwnedClaim(f);
  await f.store.command(f.claim.runId, { kind: 'approve', body: { approval: 'not-dispatched' } });
  f.clock.now += 60_001;
  const next = await f.store.claim(f.claim.runId, 'replacement', { leaseMs: 60_000 });
  assert.ok(next.epoch > f.claim.epoch);
  await f.store.runs.update(next, { state: 'parked' });
  const receipt = await f.side.held.projectCheckpoint();
  assert.equal(receipt.status, 'uncertain'); assert.equal(syncs, 0);
});
