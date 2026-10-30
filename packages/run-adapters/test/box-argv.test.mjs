// ./host's box (box-bwrap.ts): the bwrap argv is built from an explicit allowlist and checked, structurally and
// completely, before anything is spawned. These run anywhere: no bwrap is started.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BOX_EGRESS_SOCKET, BOX_FORWARD, BOX_MODEL_SOCKET, BoxError, boxChild, boxMounts, buildBoxArgv, checkBoxArgv } from '@parcha/agentrun-adapters/host';

function spec(extra = {}) {
  const run = mkdtempSync(join(tmpdir(), 'box-argv-'));
  const socket = join(run, 'model.sock');
  writeFileSync(socket, '');
  return { workspace: join(run, 'work'), homes: { HOME: join(run, 'home') }, readOnly: ['/usr/local/lib/node-test'], modelSocket: socket, modelPort: 8123, env: { PATH: '/usr/bin:/bin', HOME: join(run, 'home'), KEY: 'session-key' }, ...extra };
}
const harness = { command: '/usr/bin/true', args: [] };
const refused = (argv, s, why) => assert.throws(() => checkBoxArgv(argv, s), (e) => e instanceof BoxError && e.code === 'box_refused' && why.test(e.message), `not refused for ${why}: ${argv.join(' ')}`);

test('the built argv carries every isolating flag, the allowlist, --clearenv then the spec\'s environment, the two fds, and passes the check', () => {
  const s = spec();
  const argv = buildBoxArgv(s, boxChild(s, harness));
  checkBoxArgv(argv, s);
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session', '--disable-userns', '--clearenv']) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(argv.slice(argv.indexOf('--proc'), argv.indexOf('--proc') + 2), ['--proc', '/proc']);
  assert.deepEqual(argv.slice(argv.indexOf('--info-fd'), argv.indexOf('--info-fd') + 4), ['--info-fd', '3', '--block-fd', '4']);
  assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', process.execPath, BOX_FORWARD, '--listen', `8123=${BOX_MODEL_SOCKET}`, '--', '/usr/bin/true']);
  const setenv = argv.flatMap((a, i) => (a === '--setenv' ? [`${argv[i + 1]}=${argv[i + 2]}`] : []));
  assert.deepEqual(setenv.sort(), Object.entries(s.env).map(([k, v]) => `${k}=${v}`).sort());
  assert.ok(argv.indexOf('--clearenv') < argv.indexOf('--setenv'));
});

test('the allowlist binds nothing of the host but the system, /etc\'s named subset, node and the spec\'s own paths', () => {
  const s = spec();
  const binds = boxMounts(s).filter((m) => m[0] === '--bind' || m[0] === '--ro-bind');
  const sources = binds.map((m) => m[1]);
  for (const path of ['/', '/etc', '/run', '/var', '/srv', '/home', '/root', '/data', '/proc', homedir()]) assert.ok(!sources.includes(path), `${path} is bound`);
  for (const m of binds) assert.ok(!m[1].startsWith(`${homedir()}/`), `${m[1]} is under the server's home`);
  assert.ok(boxMounts(s).some((m) => m[0] === '--ro-bind-data' && m[2] === '/etc/passwd'), 'passwd is generated, not the host\'s');
  assert.ok(!sources.includes('/etc/passwd') && !sources.includes('/etc/shadow'));
});

test('the check refuses an argv with any one isolating flag removed, each by name', () => {
  const s = spec();
  const argv = buildBoxArgv(s, boxChild(s, harness));
  for (const flag of ['--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session', '--disable-userns', '--clearenv', '--unshare-user', '--unshare-ipc', '--unshare-uts']) {
    const without = argv.filter((a) => a !== flag);
    refused(without, s, flag === '--clearenv' ? /--setenv before --clearenv|--clearenv is missing/ : new RegExp(`${flag} is missing`));
  }
  const noProc = [...argv];
  noProc.splice(noProc.indexOf('--proc'), 2);
  refused(noProc, s, /the mounts are not the allowlist/);
  const noBlock = [...argv];
  noBlock.splice(noBlock.indexOf('--block-fd'), 2);
  refused(noBlock, s, /--block-fd is missing/);
});

test('the check refuses an extra bind, the root, /etc whole, the server\'s home, a CLI\'s config, --share-net, and an option no box uses', () => {
  const s = spec();
  const argv = buildBoxArgv(s, boxChild(s, harness));
  const at = argv.indexOf('--chdir');
  const add = (...extra) => [...argv.slice(0, at), ...extra, ...argv.slice(at)];
  refused(add('--ro-bind', '/srv', '/srv'), s, /names \/srv/);
  refused(add('--ro-bind', '/', '/'), s, /names \/|binds the root/);
  refused(add('--ro-bind', '/etc', '/etc'), s, /names \/etc/);
  refused(add('--bind', homedir(), '/h'), s, /server's own/);
  refused(add('--ro-bind', join(homedir(), '.claude'), '/c'), s, /server's own/);
  refused(add('--ro-bind', '/usr/share', '/usr/share'), s, /the mounts are not the allowlist/);
  refused(add('--share-net'), s, /--share-net is not an option a box uses/);
  refused(add('--dev-bind', '/dev', '/dev'), s, /--dev-bind is not an option a box uses/);
  refused(add('--unsetenv', 'X'), s, /--unsetenv is not an option a box uses/);
  refused(add('--as-pid-1'), s, /--as-pid-1 is not an option a box uses/);
});

test('the check refuses an environment that is not the spec\'s: one more pair, one changed, or a pair before --clearenv', () => {
  const s = spec();
  const argv = buildBoxArgv(s, boxChild(s, harness));
  const at = argv.indexOf('--info-fd');
  refused([...argv.slice(0, at), '--setenv', 'OPENAI_API_KEY', 'sk-x', ...argv.slice(at)], s, /--setenv pairs are not the spec's environment/);
  const changed = argv.map((a) => (a === 'session-key' ? 'other-key' : a));
  refused(changed, s, /--setenv pairs are not the spec's environment/);
  const clear = argv.indexOf('--clearenv');
  refused(['--setenv', 'X', '1', ...argv.slice(0, clear), ...argv.slice(clear)], s, /--setenv before --clearenv/);
  refused(argv.slice(0, argv.indexOf('--')), s, /no child after --/);
});

test('a spec that would bind the root, a forbidden tree, or anything of the server\'s home is refused before an argv exists', () => {
  for (const [field, value, why] of [
    ['readOnly', ['/'], /is or holds \//],
    ['readOnly', ['/etc'], /is or holds \/etc/],
    ['readOnly', ['/data'], /is or holds \/data/],
    ['readOnly', [join(homedir(), '.npm')], /server's own/],
    ['workspace', homedir(), /server's own/],
    ['workspace', 'relative/work', /not an absolute, normalized path/],
    ['homes', { HOME: '/home' }, /is or holds \/home/],
  ]) {
    const s = spec({ [field]: value });
    assert.throws(() => buildBoxArgv(s, boxChild(s, harness)), (e) => e instanceof BoxError && e.code === 'box_refused' && why.test(e.message), `${field}=${JSON.stringify(value)}`);
  }
  // A run's own directory under /data is a path a box may bind: only /data itself, or what holds it, is refused.
  const s = spec({ workspace: '/data/runs/r1/work' });
  checkBoxArgv(buildBoxArgv(s, boxChild(s, harness)), s);
});

test('the box\'s first command is this server\'s node running this kernel\'s forwarder on exactly the spec\'s sockets: one more --listen, another socket, a forwarder from elsewhere, or no harness is refused by name', () => {
  const s = spec();
  const argv = buildBoxArgv(s, boxChild(s, harness));
  const head = argv.slice(0, argv.indexOf('--') + 1);
  const at = (command) => [...head, ...command];
  const model = ['--listen', `8123=${BOX_MODEL_SOCKET}`];
  checkBoxArgv(at([process.execPath, BOX_FORWARD, ...model, '--', '/usr/bin/true']), s);
  refused(at([process.execPath, BOX_FORWARD, ...model, '--listen', `8124=${BOX_EGRESS_SOCKET}`, '--', '/usr/bin/true']), s, /--listen operands are not the spec's sockets/);
  refused(at([process.execPath, BOX_FORWARD, '--listen', '8123=/run/agentrun/other.sock', '--', '/usr/bin/true']), s, /--listen operands are not the spec's sockets/);
  refused(at([process.execPath, BOX_FORWARD, '--listen', `9999=${BOX_MODEL_SOCKET}`, '--', '/usr/bin/true']), s, /--listen operands are not the spec's sockets/);
  refused(at([process.execPath, BOX_FORWARD, '--', '/usr/bin/true']), s, /--listen operands are not the spec's sockets: none/);
  refused(at([process.execPath, join(tmpdir(), 'box-forward.js'), ...model, '--', '/usr/bin/true']), s, /not this kernel's box-forward\.js/);
  refused(at(['/usr/bin/node', BOX_FORWARD, ...model, '--', '/usr/bin/true']), s, /not this server's node/);
  refused(at(['/usr/bin/true']), s, /not this server's node/);
  refused(at([process.execPath, BOX_FORWARD, ...model, '--']), s, /no harness after --/);
  refused(at([process.execPath, BOX_FORWARD, ...model, '/usr/bin/true']), s, /no harness after --/);
  // With an egress proxy: both sockets, the model's first; the model's alone is refused.
  const e = spec({ egressSocket: s.modelSocket, egressPort: 8124 });
  const child = boxChild(e, harness);
  assert.deepEqual(child.args.slice(1, 6), ['--listen', `8123=${BOX_MODEL_SOCKET}`, '--listen', `8124=${BOX_EGRESS_SOCKET}`, '--']);
  const egressArgv = buildBoxArgv(e, child);
  checkBoxArgv(egressArgv, e);
  refused([...egressArgv.slice(0, egressArgv.indexOf('--') + 1), process.execPath, BOX_FORWARD, ...model, '--', '/usr/bin/true'], e, /--listen operands are not the spec's sockets/);
  // A port that is not one, or an egress socket without its port, never makes a command.
  assert.throws(() => boxChild(spec({ modelPort: 0 }), harness), (err) => err instanceof BoxError && err.code === 'box_refused' && /the model port 0 is not a port/.test(err.message));
  assert.throws(() => boxChild(spec({ egressSocket: s.modelSocket }), harness), (err) => err instanceof BoxError && /the egress port undefined is not a port/.test(err.message));
});

test('serve\'s data root is never shown to a box: a bind of it, or of any parent of it, is refused by name; one under it is not', () => {
  const base = mkdtempSync(join(tmpdir(), 'box-data-'));
  const dataRoot = join(base, 'data');
  const hidden = [dataRoot];
  for (const path of [dataRoot, base]) {
    const s = spec({ readOnly: ['/usr/local/lib/node-test', path] });
    refused(buildBoxArgv(s, boxChild(s, harness)), s, /shows .* which a box never sees/);
    assert.throws(() => checkBoxArgv(buildBoxArgv(s, boxChild(s, harness)), s, { hidden }), (e) => e instanceof BoxError && new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} shows`).test(e.message), path);
  }
  // A run's own workspace under the data root shows only itself.
  const s = spec({ workspace: join(dataRoot, 'runs', 'r1', 'work') });
  checkBoxArgv(buildBoxArgv(s, boxChild(s, harness)), s, { hidden });
});
