import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const preload = new URL('./deny-remote.mjs', import.meta.url).pathname;
const probe = source => spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], { encoding: 'utf8' });

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
const tries = [() => http.get('http://example.com/'), () => fetch('http://127.0.0.1:1/'), () => net.connect({ path: '/tmp/x.sock' })];
for (const attempt of tries) { try { attempt(); console.log('allowed'); } catch (e) { console.log(e.message.split(':')[1].trim()); } }`);
  assert.equal(result.stdout.trim().split('\n').filter(line => line === 'allowed').length, 0, result.stdout + result.stderr);
});
