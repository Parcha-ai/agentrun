import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const preload = new URL('./deny-remote.mjs', import.meta.url).pathname;
// A probe that dies prints nothing, so every probe must exit 0 within the timeout before its output is read.
const probe = source => {
  const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  return result;
};
const prefix = 'Networking beyond loopback prohibited during package smoke tests: ';

const serve = `import http from 'node:http'; const server = http.createServer((_, res) => res.end('hi')).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r)); const { port } = server.address();`;

test('a request to a server on loopback goes through', () => {
  const result = probe(`${serve} const body = await new Promise(r => http.get({ host: '127.0.0.1', port }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => r(t)); })); console.log(body); server.close();`);
  assert.equal(result.stdout.trim(), 'hi', result.stderr);
});

test('a socket to any other address is refused', () => {
  const result = probe(`import net from 'node:net'; try { net.connect(80, '192.0.2.1'); } catch (e) { console.log(e.message); }`);
  assert.match(result.stdout, /beyond loopback prohibited during package smoke tests: 192\.0\.2\.1/);
});

test('http, fetch and unix sockets are refused beyond loopback', () => {
  const result = probe(`import http from 'node:http'; import net from 'node:net';
const tries = [() => http.get('http://example.com/'), () => fetch('http://127.0.0.1:1/'), () => net.connect({ path: '/tmp/x.sock' }), () => net.connect('/tmp/y.sock'), () => new net.Socket().connect('/tmp/z.sock')];
for (const attempt of tries) { try { attempt(); console.log('allowed'); } catch (e) { console.log(e.message); } }`);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    prefix + 'example.com', prefix + 'fetch', prefix + 'unix socket /tmp/x.sock', prefix + 'unix socket /tmp/y.sock', prefix + 'unix socket /tmp/z.sock',
  ]);
});

test('Socket.connect called directly refuses a path and a remote address, and admits a numeric port on loopback', () => {
  const result = probe(`import net from 'node:net';
for (const args of [['/tmp/x.sock'], [80, '192.0.2.1'], ['80', '192.0.2.1']]) { try { new net.Socket().connect(...args); console.log('allowed'); } catch (e) { console.log(e.message); } }
const socket = new net.Socket(); socket.on('error', () => console.log('loopback reached connect')); socket.connect('1', '127.0.0.1');`);
  assert.deepEqual(result.stdout.trim().split('\n'), [prefix + 'unix socket /tmp/x.sock', prefix + '192.0.2.1', prefix + '192.0.2.1', 'loopback reached connect']);
});
