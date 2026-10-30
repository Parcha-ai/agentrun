// ./host's box (box-bwrap.ts): the order a box starts in. The record's `ahead` is on disk before the spawn; the box's
// pid 1 is recorded (`started`) before the box is released, so no process of the harness runs before its pid is on disk;
// a failed `started` kills the box before the harness ran. A stand-in for bwrap is spawned here (bwrap itself runs in the
// CI job's box tests): it reports a real process as the namespace's pid 1 on --info-fd, waits for a byte on --block-fd,
// and only then "runs the harness", which writes a marker and echoes its stdin.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { BoxError, boxListens, forwardChild, buildBoxArgv, bwrapBox, startTimeOf } from '@parcha/agentrun-kernel/host';

/** The harness each box runs, behind the forwarder (`forwardChild(harness, boxListens(spec))`). */
const harness = { command: '/usr/bin/true', args: [] };

function setup() {
  const run = mkdtempSync(join(tmpdir(), 'box-start-'));
  const socket = join(run, 'model.sock');
  writeFileSync(socket, '');
  const spec = { workspace: join(run, 'work'), homes: { HOME: join(run, 'home') }, readOnly: [], modelSocket: socket, modelPort: 8123, env: { PATH: '/usr/bin:/bin' } };
  const recordFile = join(run, 'box.json');
  const marker = join(run, 'harness-ran');
  /** The serve-side recorder: each write synced before it returns. */
  const durable = (record) => {
    const fd = openSync(recordFile, 'w');
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    closeSync(fd);
  };
  return { run, spec, recordFile, marker, durable };
}

/** A stand-in for bwrap: pid 1 is a real sleep (so its start time and namespace are real), released by a byte on fd 4. */
function fakeBwrap({ marker, beforeInfo, onSpawn, exitBeforeInfo }) {
  const calls = [];
  const procs = [];
  const spawnFake = (command, args, options) => {
    calls.push({ command, args, options });
    onSpawn?.();
    const proc = new EventEmitter();
    const stdio = Array.from({ length: 7 }, () => new PassThrough());
    proc.stdio = stdio;
    [proc.stdin, proc.stdout, proc.stderr] = stdio;
    const pid1 = spawn('sleep', ['60'], { stdio: 'ignore' });
    proc.pid1 = pid1;
    procs.push(proc);
    proc.pid = pid1.pid;
    proc.kill = () => pid1.kill('SIGKILL');
    let stdin = Buffer.alloc(0);
    stdio[0].on('data', (b) => (stdin = Buffer.concat([stdin, b])));
    const close = (code) => setImmediate(() => proc.emit('close', code, null));
    pid1.once('exit', () => close(137));
    if (exitBeforeInfo) {
      stdio[2].write(exitBeforeInfo);
      pid1.kill('SIGKILL');
      return proc;
    }
    setImmediate(() => {
      beforeInfo?.();
      stdio[3].write(`{\n    "child-pid": ${pid1.pid}\n}\n`);
    });
    stdio[4].on('data', () => {
      // Released: the harness runs. Its first act is the marker; then it echoes what reached its stdin.
      writeFileSync(marker, 'ran');
      stdio[1].write(stdin);
    });
    return proc;
  };
  return { spawnFake, calls, procs };
}

test('the record\'s ahead is on disk before the spawn, and carries this process as its writer', async () => {
  const { spec, recordFile, marker, durable } = setup();
  let atSpawn;
  const { spawnFake } = fakeBwrap({ marker, onSpawn: () => (atSpawn = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : undefined) });
  const box = bwrapBox({ spawn: spawnFake });
  const boxed = box.start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async (r) => durable(r) });
  assert.ok(atSpawn, 'the ahead record was not on disk when bwrap was spawned');
  assert.equal(typeof atSpawn.id, 'string');
  assert.deepEqual(atSpawn.writer, { pid: process.pid, startTime: startTimeOf(process.pid) });
  assert.equal(atSpawn.pid, undefined, 'no pid before the box exists');
  await boxed.ready;
  boxed.kill();
});

test('no process of the harness runs before started() is durable: the marker is absent while it writes, present after the release', async () => {
  const { spec, recordFile, marker, durable } = setup();
  const { spawnFake } = fakeBwrap({ marker });
  let markerDuringStarted;
  const box = bwrapBox({ spawn: spawnFake });
  const boxed = box.start(spec, forwardChild(harness, boxListens(spec)), {
    ahead: durable,
    started: async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 50)); // a slow disk: the box must still wait
      durable(r);
      markerDuringStarted = existsSync(marker);
    },
  });
  const record = await boxed.ready;
  assert.equal(markerDuringStarted, false, 'the harness ran before its record was durable');
  const onDisk = JSON.parse(readFileSync(recordFile, 'utf8'));
  assert.equal(onDisk.pid, record.pid);
  assert.equal(onDisk.startTime, startTimeOf(record.pid));
  assert.match(onDisk.pidns, /^pid:\[\d+\]$/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(marker), 'released, the harness runs');
  boxed.kill();
});

test('a failed started() kills the box: the harness never ran, and ready rejects with box_record_failed', async () => {
  const { spec, marker, durable } = setup();
  const { spawnFake, procs } = fakeBwrap({ marker });
  const box = bwrapBox({ spawn: spawnFake, reapMs: 200 });
  const boxed = box.start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async () => { throw new Error('disk full'); } });
  await assert.rejects(boxed.ready, (e) => e instanceof BoxError && e.code === 'box_record_failed' && /disk full/.test(e.message));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(marker), false, 'the harness ran although its record failed');
  assert.equal(procs[0].pid1.exitCode === null && procs[0].pid1.signalCode === null, false, 'the box\'s pid 1 is still alive');
});

test('stdin written before the release reaches the harness intact', async () => {
  const { spec, marker, durable } = setup();
  const { spawnFake } = fakeBwrap({ marker });
  const box = bwrapBox({ spawn: spawnFake });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const boxed = box.start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async (r) => { await gate; durable(r); } });
  const sent = Buffer.concat([Buffer.from('{"type":"user","message":"hi"}\n'), Buffer.from([0, 1, 2, 255, 13, 10])]);
  boxed.child.stdin.write(sent); // the SDK writes at once, before the box is released
  let out = Buffer.alloc(0);
  boxed.child.stdout.on('data', (b) => (out = Buffer.concat([out, b])));
  release();
  await boxed.ready;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(out.equals(sent), `the harness read ${JSON.stringify(out.toString('latin1'))}`);
  boxed.kill();
});

test('a refused argv throws synchronously and nothing is spawned or recorded', () => {
  const { spec, marker, durable } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  let aheads = 0;
  const box = bwrapBox({ spawn: spawnFake });
  assert.throws(() => box.start({ ...spec, readOnly: ['/'] }, forwardChild(harness, boxListens(spec)), { ahead: () => aheads++, started: async () => {} }), (e) => e instanceof BoxError && e.code === 'box_refused');
  assert.equal(calls.length, 0);
  assert.equal(aheads, 0);
  void durable;
});

test('an argv the builder got wrong is still refused before the spawn: start checks what it is about to run', () => {
  const { spec, marker } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  let aheads = 0;
  const box = bwrapBox({ spawn: spawnFake, buildArgv: (s, c) => buildBoxArgv(s, c).filter((a) => a !== '--unshare-net') });
  assert.throws(() => box.start(spec, forwardChild(harness, boxListens(spec)), { ahead: () => aheads++, started: async () => {} }), (e) => e instanceof BoxError && e.code === 'box_refused' && /--unshare-net is missing/.test(e.message));
  assert.equal(calls.length, 0);
  assert.equal(aheads, 0);
});

test('an ahead that throws stops the start before the spawn', () => {
  const { spec, marker } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  const box = bwrapBox({ spawn: spawnFake });
  assert.throws(() => box.start(spec, forwardChild(harness, boxListens(spec)), { ahead: () => { throw new Error('no disk'); }, started: async () => {} }), /no disk/);
  assert.equal(calls.length, 0);
});

test('bwrap that ends before reporting its pid rejects ready with the named cause (a host that denies user namespaces)', async () => {
  const { spec, marker, durable } = setup();
  const { spawnFake } = fakeBwrap({ marker, exitBeforeInfo: 'bwrap: setting up uid map: Permission denied\n' });
  const box = bwrapBox({ spawn: spawnFake });
  const boxed = box.start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async () => assert.fail('started without a pid') });
  await assert.rejects(boxed.ready, (e) => e instanceof BoxError && e.code === 'bwrap_userns_denied');
  assert.equal(existsSync(marker), false);
});

test('bwrap is started with only PATH in its environment, never the run process\'s', () => {
  const { spec, marker, durable } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  process.env.BOX_TEST_CANARY = 'canary';
  try {
    const boxed = bwrapBox({ spawn: spawnFake }).start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async (r) => durable(r) });
    assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin' });
    boxed.ready.then(() => boxed.kill());
  } finally {
    delete process.env.BOX_TEST_CANARY;
  }
});

test('a box\'s cgroup is refused by name before anything is made, spawned or recorded unless it is normalized and strictly under the delegated root', () => {
  const { spec, marker } = setup();
  const root = mkdtempSync(join(tmpdir(), 'box-cgroot-'));
  // A third element of null: no delegated root configured (an undefined one would take the default).
  for (const [cgroup, why, given = root] of [
    [`${root}/runs/a/../b`, /not an absolute, normalized path/],
    [`${root}/runs/a/`, /not an absolute, normalized path/],
    ['runs/a', /not an absolute, normalized path/],
    [root, /the delegated root itself/],
    [`${root}x/runs/a`, /not under the delegated root/],
    [`${root}/runs/a`, /no delegated cgroup root is configured/, null],
  ]) {
    const { spawnFake, calls } = fakeBwrap({ marker });
    let aheads = 0;
    const cgroupRoot = given ?? undefined;
    assert.throws(() => bwrapBox({ spawn: spawnFake, cgroupRoot }).start({ ...spec, cgroup }, forwardChild(harness, boxListens(spec)), { ahead: () => aheads++, started: async () => {} }), (e) => e instanceof BoxError && e.code === 'box_refused' && why.test(e.message), cgroup);
    assert.equal(calls.length, 0, `spawned for ${cgroup}`);
    assert.equal(aheads, 0, `recorded for ${cgroup}`);
    assert.equal(existsSync(`${root}x/runs/a`) || existsSync(join(root, 'b')), false, `made for ${cgroup}`);
  }
});

test('a box cgroup that already exists (another run\'s) is refused before the spawn and never recorded; parents are made, the leaf is not adopted', () => {
  const { spec, marker } = setup();
  const root = mkdtempSync(join(tmpdir(), 'box-cgroot-'));
  const theirs = join(root, 'runs', 'a');
  mkdirSync(theirs, { recursive: true });
  const { spawnFake, calls } = fakeBwrap({ marker });
  let aheads = 0;
  assert.throws(() => bwrapBox({ spawn: spawnFake, cgroupRoot: root, selfCgroup: () => root }).start({ ...spec, cgroup: theirs }, forwardChild(harness, boxListens(spec)), { ahead: () => aheads++, started: async () => {} }), (e) => e instanceof BoxError && e.code === 'box_refused' && /already exists/.test(e.message));
  assert.equal(calls.length, 0);
  assert.equal(aheads, 0, 'a record named a cgroup this box did not make');
});

test('an ahead that throws removes the box cgroup it made, and nothing is spawned', () => {
  const { spec, marker } = setup();
  const root = mkdtempSync(join(tmpdir(), 'box-cgroot-'));
  const mine = join(root, 'runs', 'b');
  const { spawnFake, calls } = fakeBwrap({ marker });
  assert.throws(() => bwrapBox({ spawn: spawnFake, cgroupRoot: root, selfCgroup: () => root }).start({ ...spec, cgroup: mine }, forwardChild(harness, boxListens(spec)), { ahead: () => { throw new Error('no disk'); }, started: async () => {} }), /no disk/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(mine), false, 'the unrecorded cgroup was left behind');
  assert.ok(existsSync(join(root, 'runs')), 'its parent, made recursively, stays');
});

test("bwrap that dies after it reported a pid 1 (a host that restricts user namespaces) rejects ready by name with bwrap's words, and its reset pipes never end this process", async () => {
  const { spec, durable } = setup();
  // A pid 1 that is already gone: a short-lived process, waited for.
  const gone = spawn('true', [], { stdio: 'ignore' });
  await new Promise((resolve) => gone.once('exit', resolve));
  const spawnFake = () => {
    const proc = new EventEmitter();
    const stdio = Array.from({ length: 7 }, () => new PassThrough());
    proc.stdio = stdio;
    [proc.stdin, proc.stdout, proc.stderr] = stdio;
    proc.pid = gone.pid;
    proc.kill = () => {};
    setImmediate(() => {
      stdio[3].write(`{\n    "child-pid": ${gone.pid}\n}\n`);
      stdio[2].write('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n');
      // bwrap's end resets the box's own pipes, as a real one does.
      for (const fd of [3, 4, 5, 6]) stdio[fd].destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      setImmediate(() => proc.emit('close', 1, null));
    });
    return proc;
  };
  const boxed = bwrapBox({ spawn: spawnFake }).start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async () => assert.fail('started for a pid 1 that was gone') });
  await assert.rejects(boxed.ready, (e) => e instanceof BoxError && e.code === 'bwrap_userns_denied' && /Failed RTM_NEWADDR/.test(e.message) && /agentrun-box install/.test(e.message));
  await boxed.exited;
});

test("bwrap that says why only AFTER its reported pid 1 has vanished (the order a real host shows) still fails by name with its words: the start waits for bwrap's end", async () => {
  const { spec, durable } = setup();
  const gone = spawn('true', [], { stdio: 'ignore' });
  await new Promise((resolve) => gone.once('exit', resolve));
  const spawnFake = () => {
    const proc = new EventEmitter();
    const stdio = Array.from({ length: 7 }, () => new PassThrough());
    proc.stdio = stdio;
    [proc.stdin, proc.stdout, proc.stderr] = stdio;
    proc.pid = gone.pid;
    proc.kill = () => {};
    // pid 1 first, already gone; bwrap's reason 150 ms later; then its end, which resets the box's own pipes.
    setImmediate(() => stdio[3].write(`{\n    "child-pid": ${gone.pid}\n}\n`));
    setTimeout(() => {
      stdio[2].write('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n');
      for (const fd of [3, 4, 5, 6]) stdio[fd].destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      setImmediate(() => proc.emit('close', 1, null));
    }, 150);
    return proc;
  };
  const boxed = bwrapBox({ spawn: spawnFake }).start(spec, forwardChild(harness, boxListens(spec)), { ahead: durable, started: async () => assert.fail('started for a pid 1 that was gone') });
  await assert.rejects(boxed.ready, (e) => e instanceof BoxError && e.code === 'bwrap_userns_denied' && /Failed RTM_NEWADDR/.test(e.message));
  await boxed.exited;
});

test("a server whose own cgroup is not under the delegated root is refused by name before anything is made, spawned or recorded: it must start inside it", () => {
  const { spec, marker } = setup();
  const root = mkdtempSync(join(tmpdir(), 'box-cgroot-'));
  const cgroup = join(root, 'runs', 'r1');
  for (const [own, refused] of [['/sys/fs/cgroup/system.slice/other.service', true], [undefined, true], [`${root}x/scope`, true], [root, false], [join(root, 'init'), false]]) {
    const { spawnFake, calls } = fakeBwrap({ marker });
    let aheads = 0;
    const start = () => bwrapBox({ spawn: spawnFake, cgroupRoot: root, selfCgroup: () => own }).start({ ...spec, cgroup }, forwardChild(harness, boxListens(spec)), { ahead: () => aheads++, started: async () => {} });
    if (refused) {
      assert.throws(start, (e) => e instanceof BoxError && e.code === 'box_refused' && /is not under the delegated root .*start the server inside its delegated subtree/.test(e.message), String(own));
      assert.equal(calls.length, 0);
      assert.equal(aheads, 0);
      assert.equal(existsSync(cgroup), false, `a cgroup was made for ${own}`);
    } else {
      const boxed = start();
      assert.equal(aheads, 1, `a server inside the root (${own}) starts its box`);
      boxed.ready.then(() => boxed.kill(), () => {});
      rmdirSync(cgroup);
    }
  }
});
