// The box's first command (host/box-forward.ts), on its own, on this host's loopback: it serves each socket at its port,
// runs the harness on its own stdio, passes the harness's signals on, and exits as the harness did.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { BOX_FORWARD, forwardChild, parseForward } from '@parcha/agentrun-kernel/host';

const FORWARD = fileURLToPath(new URL('../dist/host/box-forward.js', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'kernel-forward-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** A port nothing listens on now. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A Unix socket that answers each connection with `name`, then the bytes it was sent. */
async function echoSocket(t, name) {
  const path = join(ROOT, `s${n++}.sock`);
  const server = createServer((c) => { c.write(`${name}:`); c.pipe(c); });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => server.close());
  return path;
}

/** The forwarder with `args`, in a process group of its own, which the test ends whole when it is done: a harness this
 *  host's sh leaves behind must not hold the test's pipes open. `up` resolves on the harness's first line of output. */
function run(t, args, input) {
  const child = spawn(process.execPath, [FORWARD, ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  let out = '';
  let err = '';
  let up;
  const started = new Promise((resolve) => { up = resolve; });
  child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) up(); });
  child.stderr.on('data', (d) => { err += d; });
  if (input !== undefined) child.stdin.end(input);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, out, err })));
  return { child, exited, up: started };
}

async function ask(port, text) {
  for (let i = 0; i < 100; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const c = connect(port, '127.0.0.1');
        let got = '';
        c.on('data', (d) => { got += d; if (got.endsWith(text)) { c.end(); resolve(got); } });
        c.once('error', reject);
        c.once('connect', () => c.write(text));
      });
    } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`nothing answered at ${port}`);
}

test('its arguments: each --listen a port and an absolute socket path, then the harness after --; anything else is refused by name', () => {
  assert.deepEqual(parseForward(['--listen', '4100=/run/agentrun/model.sock', '--', '/bin/cli', '-x']), { listen: [{ port: 4100, socket: '/run/agentrun/model.sock' }], command: '/bin/cli', args: ['-x'] });
  for (const bad of [['--listen', '0=/s', '--', 'x'], ['--listen', '4100=rel.sock', '--', 'x'], ['--listen', '70000=/s', '--', 'x'], ['--port', '1=/s', '--', 'x'], ['--listen', '1=/s'], ['--listen', '1=/a', '--listen', '1=/b', '--', 'x']]) {
    assert.throws(() => parseForward(bad), /^Error: box-forward: /, JSON.stringify(bad));
  }
});

test("the box's first command is built by one builder, and the forwarder reads back exactly what it was given", () => {
  const harness = { command: '/opt/cli', args: ['--x', 'a b', '--', '--listen'] };
  const listen = [{ port: 4100, socket: '/run/agentrun/model.sock' }, { port: 4101, socket: '/run/agentrun/egress.sock' }];
  const child = forwardChild(harness, listen);
  assert.equal(child.command, process.execPath);
  assert.equal(child.args[0], BOX_FORWARD);
  assert.equal(BOX_FORWARD, FORWARD, "the builder names this very script");
  assert.deepEqual(parseForward(child.args.slice(1)), { listen, command: harness.command, args: harness.args }, "the harness's own -- and --listen are its arguments, untouched");
});

test("the harness's stdin and stdout pass through it unchanged, and it exits with the harness's code", async (t) => {
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 10, 0x7f]).toString('latin1');
  const { exited } = run(t, ['--', process.execPath, '-e', "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exitCode = 7)"], bytes);
  const { code, out } = await exited;
  assert.equal(code, 7);
  assert.equal(out, bytes);
});

test('each port reaches its own socket, and nothing else', async (t) => {
  const model = await echoSocket(t, 'model');
  const egress = await echoSocket(t, 'egress');
  // The forwarder starts the harness only once both ports listen, so the harness's "up" is the listen itself. A free port
  // another process takes before the forwarder binds it makes the forwarder exit 71 (it cannot listen): try new ports.
  let started;
  for (let attempt = 0; attempt < 5 && !started; attempt++) {
    const [m, e] = [await freePort(), await freePort()];
    const forwarder = run(t, ['--listen', `${m}=${model}`, '--listen', `${e}=${egress}`, '--', '/bin/sh', '-c', 'echo up; exec sleep 300']);
    const first = await Promise.race([forwarder.up.then(() => 'up'), forwarder.exited.then((x) => x)]);
    if (first === 'up') started = { ...forwarder, m, e };
    else assert.equal(first.code, 71, `the forwarder exited before listening: ${JSON.stringify(first)}`);
  }
  assert.ok(started, 'the forwarder listened on free ports within five tries');
  const { child, exited, m, e } = started;
  assert.equal(await ask(m, 'hello'), 'model:hello');
  assert.equal(await ask(e, 'hi'), 'egress:hi');
  child.kill('SIGTERM');
  await exited;
});

test("TERM reaches the harness, and it exits by the harness's signal", async (t) => {
  // The harness says it runs once its trap is set; by then the forwarder relays (its handlers are set as it spawns).
  const { child, exited, up } = run(t, ['--', '/bin/sh', '-c', 'trap "exit 9" TERM; echo up; while :; do sleep 0.05; done']);
  await up;
  child.kill('SIGTERM');
  assert.equal((await exited).code, 9, 'the harness caught TERM and chose its own code');
  const killed = run(t, ['--', '/bin/sh', '-c', 'echo up; exec sleep 300']);
  await killed.up;
  killed.child.kill('SIGTERM');
  assert.equal((await killed.exited).signal, 'SIGTERM', 'a harness ended by the signal ends the forwarder by it too');
});

test('a socket with nothing behind it gives the box a closed connection, never a way past it', async (t) => {
  const port = await freePort();
  const { child, exited } = run(t, ['--listen', `${port}=${join(ROOT, 'none.sock')}`, '--', '/bin/sh', '-c', 'exec sleep 300']);
  let closed = false;
  for (let i = 0; i < 100 && !closed; i++) {
    closed = await new Promise((resolve) => {
      const c = connect(port, '127.0.0.1');
      c.once('error', () => resolve(false));
      c.once('connect', () => c.once('close', () => resolve(true)));
    });
    if (!closed) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(closed, 'the connection was accepted, then closed with nothing sent');
  child.kill('SIGTERM');
  await exited;
});
