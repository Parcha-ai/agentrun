// A box's egress: the address table, then the proxy over its own Unix socket, attacked from the side a box sits on. No
// network: names resolve through an injected lookup, and the proxy's dials go through an injected dialer to a local fake
// origin. The dialer only ever gets an address the table passed, so it never widens what the proxy reaches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { addressBytes, checkAddress, EGRESS_RANGES, startEgressProxy } from '@parcha/agentrun-kernel/host';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-egress-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let made = 0;
const socketPath = () => join(ROOT, `run-${++made}`, 'egress.sock');

// Public-looking addresses the injected lookup hands out, and the names that resolve to them.
const PUBLIC = '93.184.215.14';
const PUBLIC_B = '93.184.215.15';
// The refused targets the tests reach for, each named once.
const PRIVATE = '10.0.0.1'; // key-gate: denylist a refused test target
const METADATA = '169.254.169.254'; // key-gate: denylist a refused test target
const LOOPBACK = '127.0.0.1';
const NAMES = { 'origin.test': [PUBLIC], 'other.test': [PUBLIC_B], 'evil.test': [LOOPBACK], 'split.test': [PUBLIC, PRIVATE], 'meta.test': [METADATA] };

/** A fake origin on loopback: what every dial reaches. `/302-meta` and `/302-loop` answer redirects to local addresses. */
async function origin() {
  const seen = [];
  const heads = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} host=${req.headers.host}`);
    heads.push(req.headers);
    if (req.url === '/hop') return res.writeHead(200, { connection: 'close, x-back', 'x-back': 'hop only', 'x-kept': 'yes' }).end('hop');
    if (req.url === '/302-meta') return res.writeHead(302, { location: `http://${METADATA}/latest/meta-data/` }).end();
    if (req.url === '/302-loop') return res.writeHead(302, { location: `http://${LOOPBACK}/` }).end();
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`origin ${req.url}`);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { seen, heads, port: server.address().port, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}

/** A proxy with the injected seams; `lookups` and `dials` record what it asked for. */
async function proxy(extra = {}) {
  const fake = await origin();
  const lookups = [];
  const dials = [];
  const lines = [];
  const path = socketPath();
  mkdirSync(join(path, '..'), { recursive: true });
  const p = await startEgressProxy({
    socketPath: path,
    maxTunnels: 8,
    maxConnections: 64,
    log: (line) => lines.push(line),
    lookup: (name, _options, callback) => {
      lookups.push(name);
      const list = (extra.names ?? NAMES)[name];
      if (typeof list === 'function') return callback(null, list().map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
      if (!list) return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      callback(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    },
    dial: (address, port) => {
      dials.push(`${address}:${port}`);
      return connect(fake.port, '127.0.0.1');
    },
    ...extra.options,
  });
  return { p, path, fake, lookups, dials, lines, close: async () => { await p.close(); await fake.close(); } };
}

/** Sends `bytes` to the proxy's socket and reads until the peer ends (or `until` says enough): the raw answer. */
function talk(path, bytes, until) {
  return new Promise((ok, fail) => {
    const socket = connect(path);
    let got = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      got = Buffer.concat([got, chunk]);
      if (until?.(got)) ok({ got, socket });
    });
    socket.on('end', () => ok({ got, socket }));
    socket.on('error', fail);
    socket.write(bytes);
  });
}
const head = (raw) => {
  const text = raw.toString('latin1');
  const [status] = text.split('\r\n');
  return { status: Number(status.split(' ')[1]), line: status, text };
};
const ended = (raw) => raw.includes('\r\n\r\n');
const CONNECT = (target) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

test('the table refuses every private and local address by its named class, whatever form it is written in', (t) => {
  const cases = [
    ['10.0.0.1', 'private'], // key-gate: denylist a refused test target
    ['192.168.1.1', 'private'], // key-gate: denylist a refused test target
    ['172.31.255.255', 'private'], // key-gate: denylist a refused test target
    ['192.0.0.8', 'private'], // key-gate: denylist a refused test target
    ['100.64.0.1', 'cgnat'], // key-gate: denylist a refused test target
    ['169.254.169.254', 'link-local'], // key-gate: denylist a refused test target
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'unspecified'], // key-gate: denylist a refused test target
    ['2130706433', 'loopback'],
    ['0177.0.0.1', 'loopback'],
    ['0x7f.1', 'loopback'],
    ['127.1', 'loopback'],
    ['100.100.100.200', 'metadata'], // key-gate: denylist a refused test target
    ['168.63.129.16', 'metadata'], // key-gate: denylist a refused test target
    ['fd00:ec2::254', 'metadata'], // key-gate: denylist a refused test target
    ['224.0.0.1', 'multicast'], // key-gate: denylist a refused test target
    ['255.255.255.255', 'broadcast'], // key-gate: denylist a refused test target
    ['240.0.0.1', 'reserved'], // key-gate: denylist a refused test target
    ['198.18.0.1', 'benchmarking'], // key-gate: denylist a refused test target
    ['192.0.2.1', 'reserved'], // key-gate: denylist a refused test target
    ['198.51.100.1', 'reserved'], // key-gate: denylist a refused test target
    ['203.0.113.1', 'reserved'], // key-gate: denylist a refused test target
    ['192.88.99.1', 'reserved'], // key-gate: denylist a refused test target
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::', 'unspecified'], // key-gate: denylist a refused test target
    ['fe80::1', 'link-local'], // key-gate: denylist a refused test target
    ['fe80::1%eth0', 'link-local'], // key-gate: denylist a refused test target
    ['fd00::1', 'private'], // key-gate: denylist a refused test target
    ['fc00::1', 'private'], // key-gate: denylist a refused test target
    ['ff02::1', 'multicast'], // key-gate: denylist a refused test target
    ['::ffff:10.0.0.1', 'private'], // key-gate: denylist a refused test target
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:a00:1', 'private'], // key-gate: denylist a refused test target
    ['64:ff9b::a00:1', 'private'], // key-gate: denylist a refused test target
    ['64:ff9b::7f00:1', 'loopback'], // key-gate: denylist a refused test target
    ['64:ff9b:1::5db8:d70e', 'private'], // key-gate: denylist a refused test target
    ['2002:a00:1::', 'private'], // key-gate: denylist a refused test target
    ['2002:7f00:1::1', 'loopback'], // key-gate: denylist a refused test target
    ['::a00:1', 'reserved'], // key-gate: denylist a refused test target
    ['100::1', 'reserved'], // key-gate: denylist a refused test target
    ['2001::1', 'reserved'], // key-gate: denylist a refused test target
    ['2001:0:5db8:d70e::1', 'reserved'], // key-gate: denylist a refused test target
    ['2001:db8::1', 'reserved'], // key-gate: denylist a refused test target
  ];
  for (const [address, kind] of cases) {
    assert.deepEqual(checkAddress(address, []), { ok: false, class: kind }, address);
    t.diagnostic(`refused ${kind.padEnd(12)} ${address}`);
  }
  assert.deepEqual(checkAddress(new Uint8Array([127, 0, 0, 1]), []), { ok: false, class: 'loopback' }, 'bytes are judged as bytes');
  assert.deepEqual(checkAddress('not-an-address', []), { ok: false, class: 'invalid' });
  for (const address of [PUBLIC, '172.32.0.1', '100.128.0.1', '8.8.8.8', '2606:4700::1111', '2a00:1450::1', '2002:5db8:d70e::1']) assert.deepEqual(checkAddress(address, []), { ok: true }, address);
});

test('the IPv6 forms that carry an IPv4 address are judged by it before the global-unicast rule: public ones pass', () => {
  // The mapped and NAT64 prefixes sit outside the global unicast range: refusing that range's outside first would refuse
  // these public addresses.
  const cases = [
    ['::ffff:8.8.8.8', { ok: true }],
    ['::ffff:10.0.0.1', { ok: false, class: 'private' }], // key-gate: denylist a refused test target
    ['64:ff9b::808:808', { ok: true }],
    ['64:ff9b::a00:1', { ok: false, class: 'private' }], // key-gate: denylist a refused test target
  ];
  for (const [address, verdict] of cases) assert.deepEqual(checkAddress(address, []), verdict, address);
});

test("the host's own addresses are refused as this-host, in every form that carries them", () => {
  assert.deepEqual(checkAddress(PUBLIC, [PUBLIC]), { ok: false, class: 'this-host' });
  assert.deepEqual(checkAddress(`::ffff:${PUBLIC}`, [PUBLIC]), { ok: false, class: 'this-host' });
  assert.deepEqual(checkAddress('2606:4700::1111', ['2606:4700::1111']), { ok: false, class: 'this-host' });
  assert.deepEqual(checkAddress(PUBLIC, [PUBLIC_B]), { ok: true });
  // Every interface of the machine the test runs on is refused, by one class or another.
  for (const entry of Object.values(networkInterfaces()).flat()) {
    const local = Object.values(networkInterfaces()).flat().map((e) => e.address);
    assert.equal(checkAddress(entry.address, local).ok, false, entry.address);
  }
});

test('addressBytes reads what a resolver reads as an address, and never a name', () => {
  assert.deepEqual([...addressBytes('2130706433')], [127, 0, 0, 1]);
  assert.deepEqual([...addressBytes('0x7f.0.0.1')], [127, 0, 0, 1]);
  assert.deepEqual([...addressBytes('10.1')], [10, 0, 0, 1]);
  assert.equal(addressBytes('example.test'), undefined);
  assert.equal(addressBytes('256.0.0.1'), undefined);
  assert.equal(addressBytes('08.0.0.1'), undefined, 'not octal, not decimal');
});

test('the table is the pinned list: a change on either side (this file or the key gate) fails until both match', () => {
  // The key gate's denylist and loopback markers accept exactly these literals: equal, as a set, to the gate's own ranges
  // file (key-gate-ranges.txt, sha256 1e2b43fca6a108ce56d03c42391ef22e3c36ea357b02b7bd15d7449d8aabe476), which pins this
  // table back. A change here needs the same change there, and the gate's reviewer.
  assert.deepEqual(EGRESS_RANGES, [
    '0.0.0.0/8', // key-gate: denylist the pinned egress table
    '127.0.0.0/8',
    '10.0.0.0/8', // key-gate: denylist the pinned egress table
    '172.16.0.0/12', // key-gate: denylist the pinned egress table
    '192.168.0.0/16', // key-gate: denylist the pinned egress table
    '192.0.0.0/24', // key-gate: denylist the pinned egress table
    '100.100.100.200/32', // key-gate: denylist the pinned egress table
    '100.64.0.0/10', // key-gate: denylist the pinned egress table
    '168.63.129.16/32', // key-gate: denylist the pinned egress table
    '169.254.0.0/16', // key-gate: denylist the pinned egress table
    '198.18.0.0/15', // key-gate: denylist the pinned egress table
    '192.0.2.0/24', // key-gate: denylist the pinned egress table
    '198.51.100.0/24', // key-gate: denylist the pinned egress table
    '203.0.113.0/24', // key-gate: denylist the pinned egress table
    '192.88.99.0/24', // key-gate: denylist the pinned egress table
    '224.0.0.0/4', // key-gate: denylist the pinned egress table
    '255.255.255.255/32', // key-gate: denylist the pinned egress table
    '240.0.0.0/4', // key-gate: denylist the pinned egress table
    '::1/128',
    '::/128', // key-gate: denylist the pinned egress table
    '::ffff:0:0/96', // key-gate: denylist the pinned egress table
    '64:ff9b::/96', // key-gate: denylist the pinned egress table
    '64:ff9b:1::/48', // key-gate: denylist the pinned egress table
    '2002::/16', // key-gate: denylist the pinned egress table
    '2001::/32', // key-gate: denylist the pinned egress table
    '2001:db8::/32', // key-gate: denylist the pinned egress table
    'fd00:ec2::/32', // key-gate: denylist the pinned egress table
    'fc00::/7', // key-gate: denylist the pinned egress table
    'fe80::/10', // key-gate: denylist the pinned egress table
    'ff00::/8', // key-gate: denylist the pinned egress table
  ]);
});

test('the socket is made 0600 and is gone after close, which ends every tunnel', async () => {
  const t = await proxy();
  const mode = statSync(t.path);
  assert.ok(mode.isSocket());
  assert.equal(mode.mode & 0o777, 0o600);
  const { socket } = await talk(t.path, CONNECT('origin.test:443'), ended);
  const closed = new Promise((ok) => socket.on('close', ok));
  await t.close();
  await closed;
  assert.equal(existsSync(t.path), false);
});

test('CONNECT to a private or local target is refused with its class, before any dial', async () => {
  const t = await proxy({ options: { alsoLocal: () => [PUBLIC_B] } });
  try {
    const cases = [
      ['127.0.0.1:7340', 'loopback'],
      ['10.0.0.1:443', 'private'], // key-gate: denylist a refused test target
      ['192.168.1.1:443', 'private'], // key-gate: denylist a refused test target
      ['100.64.0.1:443', 'cgnat'], // key-gate: denylist a refused test target
      ['169.254.169.254:80', 'link-local'], // key-gate: denylist a refused test target
      ['[::ffff:10.0.0.1]:443', 'private'], // key-gate: denylist a refused test target
      ['[::ffff:127.0.0.1]:443', 'loopback'],
      ['[64:ff9b::a00:1]:443', 'private'], // key-gate: denylist a refused test target
      ['[fe80::1]:443', 'link-local'], // key-gate: denylist a refused test target
      ['[fd00::1]:443', 'private'], // key-gate: denylist a refused test target
      ['[::1]:443', 'loopback'],
      ['0.0.0.0:443', 'unspecified'], // key-gate: denylist a refused test target
      ['2130706433:80', 'loopback'],
      ['0177.0.0.1:80', 'loopback'],
      ['evil.test:443', 'loopback'],
      ['meta.test:80', 'link-local'],
      ['split.test:443', 'private'],
      [`${PUBLIC_B}:443`, 'this-host'],
      ['other.test:443', 'this-host'],
    ];
    for (const [target, kind] of cases) {
      const { got } = await talk(t.path, CONNECT(target));
      const answer = head(got);
      assert.equal(answer.status, 403, `${target}: ${answer.line}`);
      assert.match(answer.line, new RegExp(`Egress refused: ${kind}$`), target);
      assert.match(answer.text, new RegExp(`x-egress-refused: ${kind}\r\n`), target);
    }
    assert.deepEqual(t.dials, [], 'nothing was dialled');
  } finally {
    await t.close();
  }
});

test('a name is resolved once and the checked address is the one dialled', async () => {
  let n = 0;
  // A resolver that would point the name at loopback the second time it is asked.
  const t = await proxy({ names: { ...NAMES, 'flip.test': () => (n++ === 0 ? [PUBLIC] : ['127.0.0.1']) } });
  try {
    const { got, socket } = await talk(t.path, CONNECT('flip.test:443'), ended);
    assert.equal(head(got).status, 200);
    socket.destroy();
    assert.deepEqual(t.lookups, ['flip.test']);
    assert.deepEqual(t.dials, [`${PUBLIC}:443`]);
  } finally {
    await t.close();
  }
});

test('a public CONNECT tunnels to the checked address, and the bytes pass both ways', async () => {
  const t = await proxy();
  try {
    const { got, socket } = await talk(t.path, CONNECT('origin.test:443'), ended);
    assert.equal(head(got).status, 200);
    const answer = await new Promise((ok) => {
      let text = '';
      socket.on('data', (chunk) => { text += chunk; if (text.includes('origin /through')) ok(text); });
      socket.write('GET /through HTTP/1.1\r\nHost: origin.test\r\nConnection: close\r\n\r\n');
    });
    assert.match(answer, /^HTTP\/1\.1 200/);
    assert.deepEqual(t.dials, [`${PUBLIC}:443`]);
    socket.destroy();
  } finally {
    await t.close();
  }
});

test("plain HTTP goes to the URI's host; a Host header naming another host is refused (400) before any dial", async () => {
  const t = await proxy();
  try {
    const ok = head((await talk(t.path, 'GET http://origin.test/page HTTP/1.1\r\nHost: origin.test\r\nConnection: close\r\n\r\n')).got);
    assert.equal(ok.status, 200);
    assert.match(ok.text, /origin \/page/);
    assert.deepEqual(t.fake.seen, ['GET /page host=origin.test']);
    const dials = t.dials.length;
    const bad = head((await talk(t.path, 'GET http://origin.test/page HTTP/1.1\r\nHost: other.test\r\nConnection: close\r\n\r\n')).got);
    assert.equal(bad.status, 400);
    assert.match(bad.line, /Egress refused: host mismatch$/);
    const local = head((await talk(t.path, `GET http://${PRIVATE}/ HTTP/1.1\r\nHost: ${PRIVATE}\r\nConnection: close\r\n\r\n`)).got);
    assert.equal(local.status, 403);
    assert.match(local.line, /Egress refused: private$/);
    assert.equal(t.dials.length, dials, 'neither was dialled');
  } finally {
    await t.close();
  }
});

test('a redirect is never followed: the 302 reaches the client as sent, and the next hop to a local address is refused', async () => {
  const t = await proxy();
  try {
    for (const [path, target, kind] of [['/302-meta', `http://${METADATA}/latest/meta-data/`, 'link-local'], ['/302-loop', `http://${LOOPBACK}/`, 'loopback']]) {
      const first = head((await talk(t.path, `GET http://origin.test${path} HTTP/1.1\r\nHost: origin.test\r\nConnection: close\r\n\r\n`)).got);
      assert.equal(first.status, 302, first.line);
      assert.match(first.text, new RegExp(`\r\nlocation: ${target.replace(/[.]/g, '\\.')}\r\n`, 'i'));
      const host = new URL(target).host;
      const next = head((await talk(t.path, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).got);
      assert.equal(next.status, 403, next.line);
      assert.match(next.line, new RegExp(`Egress refused: ${kind}$`));
    }
    assert.deepEqual(t.fake.seen, ['GET /302-meta host=origin.test', 'GET /302-loop host=origin.test'], 'the origin saw only the two first requests');
  } finally {
    await t.close();
  }
});

/** A SOCKS5 exchange: the greeting, then one request. Returns the two replies. */
async function socks(path, command, type, address, port) {
  const greeting = Buffer.from([5, 1, 0]);
  const body = type === 3 ? Buffer.concat([Buffer.from([address.length]), Buffer.from(address)]) : Buffer.from(address);
  const request = Buffer.concat([Buffer.from([5, command, 0, type]), body, Buffer.from([port >> 8, port & 0xff])]);
  const { got, socket } = await talk(path, Buffer.concat([greeting, request]), (raw) => raw.length >= 12);
  return { greet: [...got.subarray(0, 2)], reply: got[3], socket };
}

test('SOCKS5 offers CONNECT only: a public name tunnels, a local address is refused, BIND and UDP ASSOCIATE are refused by name', async () => {
  const t = await proxy();
  try {
    const good = await socks(t.path, 1, 3, 'origin.test', 443);
    assert.deepEqual(good.greet, [5, 0]);
    assert.equal(good.reply, 0);
    good.socket.destroy();
    assert.equal((await socks(t.path, 1, 1, [10, 0, 0, 1], 443)).reply, 2, 'a private v4 address');
    assert.equal((await socks(t.path, 1, 4, [...addressBytes('::ffff:127.0.0.1')], 443)).reply, 2, 'a mapped loopback v6 address');
    assert.equal((await socks(t.path, 1, 3, 'evil.test', 443)).reply, 2, 'a name for loopback');
    assert.equal((await socks(t.path, 2, 3, 'origin.test', 443)).reply, 7, 'BIND');
    assert.equal((await socks(t.path, 3, 1, [0, 0, 0, 0], 0)).reply, 7, 'UDP ASSOCIATE');
    assert.deepEqual(t.dials, [`${PUBLIC}:443`], 'only the public CONNECT was dialled');
    assert.ok(t.lines.some((line) => line.endsWith('class=socks bind')));
    assert.ok(t.lines.some((line) => line.endsWith('class=socks udp associate')));
  } finally {
    await t.close();
  }
});

test('a log line holds the host, the port, the address and the class: never a path, a query or a header', async () => {
  const t = await proxy();
  try {
    await talk(t.path, 'GET http://origin.test/secret-path?token=CANARY-QUERY HTTP/1.1\r\nHost: origin.test\r\nAuthorization: Bearer CANARY-HEADER\r\nConnection: close\r\n\r\n');
    await talk(t.path, `GET http://${PRIVATE}/x?token=CANARY-QUERY HTTP/1.1\r\nHost: ${PRIVATE}\r\nAuthorization: Bearer CANARY-HEADER\r\nConnection: close\r\n\r\n`);
    const { socket } = await talk(t.path, 'CONNECT origin.test:443 HTTP/1.1\r\nHost: origin.test:443\r\nProxy-Authorization: Basic CANARY-PROXY\r\n\r\n', ended);
    socket.destroy();
    assert.ok(t.lines.length >= 3);
    for (const line of t.lines) {
      assert.doesNotMatch(line, /CANARY|secret-path|token/, line);
      assert.match(line, /^egress (connect|http|socks) host="[^"]*" port=\d+ ip=\S+ class=[a-z0-9 -]+$/, line);
    }
  } finally {
    await t.close();
  }
});

test('the run has a cap on connections open at once and a budget in all, each refused by name', async () => {
  const t = await proxy({ options: { maxTunnels: 1, maxConnections: 2 } });
  try {
    const first = await talk(t.path, CONNECT('origin.test:443'), ended);
    assert.equal(head(first.got).status, 200);
    const second = head((await talk(t.path, CONNECT('origin.test:443'))).got);
    assert.equal(second.status, 429);
    assert.match(second.line, /Egress refused: tunnel cap$/);
    const gone = new Promise((ok) => first.socket.on('close', ok));
    first.socket.destroy();
    await gone;
    await new Promise((ok) => setImmediate(ok));
    const third = await talk(t.path, CONNECT('origin.test:443'), ended);
    assert.equal(head(third.got).status, 200, 'a slot is free again');
    third.socket.destroy();
    await new Promise((ok) => setTimeout(ok, 50));
    const fourth = head((await talk(t.path, CONNECT('origin.test:443'))).got);
    assert.equal(fourth.status, 429);
    assert.match(fourth.line, /Egress refused: connection budget$/);
    assert.equal(t.dials.length, 2);
  } finally {
    await t.close();
  }
});

test("plain HTTP is sent only to the checked address: a name the check passes is never dialled again by its own resolution", async () => {
  // The URI names localhost on a port where a canary listens. The injected resolver gives the check a public address, so
  // the proxy's one dial goes there (the fake origin). A forward that dialled the URI's host itself would resolve localhost
  // for real and reach the canary.
  const canary = [];
  const trap = createServer((req, res) => { canary.push(req.url); res.end('canary'); });
  await new Promise((ok) => trap.listen(0, LOOPBACK, ok));
  const port = trap.address().port;
  const t = await proxy({ names: { ...NAMES, localhost: [PUBLIC] } });
  try {
    const answer = head((await talk(t.path, `GET http://localhost:${port}/probe HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)).got);
    assert.equal(answer.status, 200, answer.line);
    assert.match(answer.text, /origin \/probe/);
    assert.deepEqual(t.dials, [`${PUBLIC}:${port}`]);
    assert.deepEqual(canary, [], 'nothing reached the canary on loopback');
  } finally {
    await t.close();
    trap.closeAllConnections();
    await new Promise((ok) => trap.close(ok));
  }
});

test("a live proxy's socket is never taken: a second start at its path is refused by name, and the first still serves", async () => {
  const first = await proxy();
  try {
    await assert.rejects(startEgressProxy({ socketPath: first.path, maxTunnels: 1, maxConnections: 1, log: () => {} }), { code: 'egress_socket_in_use' });
    const { got, socket } = await talk(first.path, CONNECT('origin.test:443'), ended);
    assert.equal(head(got).status, 200, 'the first proxy still answers at its path');
    socket.destroy();
  } finally {
    await first.close();
  }
});

/** A socket file at a fresh path whose listener was killed with SIGKILL: what a crashed session machine leaves. A connect
 *  to it is refused. */
async function deadSocket() {
  const path = socketPath();
  mkdirSync(join(path, '..'), { recursive: true });
  const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.env.EGRESS_TEST_SOCKET, () => console.log("up"))'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, EGRESS_TEST_SOCKET: path } });
  try {
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('the listener did not start')), 10_000);
      child.stdout.once('data', () => { clearTimeout(timer); ok(); });
    });
    const gone = new Promise((ok) => child.once('exit', ok));
    child.kill('SIGKILL');
    await gone;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  assert.ok(statSync(path).isSocket(), 'the dead listener left its socket');
  return path;
}

test('a socket its proxy left behind when it died (a connect is refused) is replaced, and the new proxy serves', async () => {
  const path = await deadSocket();
  const t = await proxy({ options: { socketPath: path } });
  try {
    const { got, socket } = await talk(path, CONNECT('origin.test:443'), ended);
    assert.equal(head(got).status, 200);
    socket.destroy();
  } finally {
    await t.close();
  }
});

test('a socket the probe cannot reach for another reason than a refusal (EACCES) is never removed: the start fails with that error', { skip: process.getuid?.() === 0 ? 'root connects to a mode-000 socket, so EACCES cannot happen' : false }, async () => {
  const path = await deadSocket();
  chmodSync(path, 0o000);
  const before = statSync(path).ino;
  await assert.rejects(startEgressProxy({ socketPath: path, maxTunnels: 1, maxConnections: 1, log: () => {} }), { code: 'EACCES' });
  assert.ok(statSync(path).isSocket(), 'the socket is still there');
  assert.equal(statSync(path).ino, before, 'the same socket, not a new one');
});

test('the temporary name the socket is made under is gone once it is in place, and close leaves nothing', async () => {
  const t = await proxy();
  const dir = join(t.path, '..');
  try {
    assert.deepEqual(readdirSync(dir), ['egress.sock']);
  } finally {
    await t.close();
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('anything at the path that is not a socket is refused by name and left as it is', async () => {
  const path = socketPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'not a socket');
  await assert.rejects(startEgressProxy({ socketPath: path, maxTunnels: 1, maxConnections: 1, log: () => {} }), { code: 'egress_socket_path_taken' });
  assert.equal(readFileSync(path, 'utf8'), 'not a socket');
});

test('a target that cannot be a host name is refused by name (400 "invalid host", SOCKS 4) before any lookup or dial', async () => {
  const t = await proxy();
  try {
    for (const target of ['bad!host.test:443', `${'a'.repeat(254)}:443`]) {
      const answer = head((await talk(t.path, CONNECT(target))).got);
      assert.equal(answer.status, 400, `${target.slice(0, 20)}: ${answer.line}`);
      assert.match(answer.line, /Egress refused: invalid host$/);
    }
    // A SOCKS5 domain may hold any byte, a space among them.
    assert.equal((await socks(t.path, 1, 3, 'bad host.test', 443)).reply, 4);
    assert.deepEqual(t.lookups, [], 'no name was looked up');
    assert.deepEqual(t.dials, [], 'nothing was dialled');
  } finally {
    await t.close();
  }
});

test("an address that carries an IPv4 one is still the host's own when the host holds that IPv6 address itself", () => {
  const cases = [
    '2002:808:808::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ];
  for (const address of cases) {
    assert.deepEqual(checkAddress(address, []), { ok: true }, `${address} alone`);
    assert.deepEqual(checkAddress(address, [address]), { ok: false, class: 'this-host' }, `${address} held by the host`);
  }
});

for (const kind of ['connect', 'http', 'socks']) {
  test(`a client that leaves while its ${kind} target is looked up frees its slot: the late connection is closed at once`, async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let asked = 0;
    const lookup = (_name, _options, callback) => { asked++; void held.then(() => callback(null, [{ address: PUBLIC, family: 4 }])); };
    // An origin that keeps its side open after the proxy's end of a connection, and never answers: only the proxy closing
    // the connection itself frees the slot.
    const accepted = new Set();
    const silent = createNetServer({ allowHalfOpen: true }, (socket) => { accepted.add(socket); socket.on('error', () => {}); });
    await new Promise((ok) => silent.listen(0, LOOPBACK, ok));
    const dials = [];
    const dial = (address, port) => { dials.push(`${address}:${port}`); return connect(silent.address().port, LOOPBACK); };
    const t = await proxy({ options: { maxTunnels: 1, lookup, dial } });
    try {
      const client = connect(t.path);
      await new Promise((ok) => client.once('connect', ok));
      if (kind === 'connect') client.write(CONNECT('slow.test:443'));
      else if (kind === 'http') client.write('GET http://slow.test/ HTTP/1.1\r\nHost: slow.test\r\n\r\n');
      else client.write(Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 3, 9]), Buffer.from('slow.test'), Buffer.from([1, 187])]));
      for (let i = 0; i < 200 && asked === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
      assert.equal(asked, 1, 'the lookup started');
      const gone = new Promise((ok) => client.once('close', ok));
      client.destroy();
      await gone;
      release();
      for (let i = 0; i < 200 && dials.length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
      assert.equal(dials.length, 1, 'the late dial was made');
      await new Promise((ok) => setTimeout(ok, 100));
      const next = await talk(t.path, CONNECT('origin.test:443'), ended);
      assert.equal(head(next.got).status, 200, `the only slot is free again: ${head(next.got).line}`);
      next.socket.destroy();
    } finally {
      await t.close();
      // The origin never closes what it accepted: they go here, or the server's close would wait on them forever.
      for (const socket of accepted) socket.destroy();
      await new Promise((ok) => silent.close(ok));
    }
  });
}

test("close removes the path only while it holds this proxy's own socket, never one another start put there", async () => {
  const t = await proxy();
  rmSync(t.path);
  const other = createNetServer();
  await new Promise((ok) => other.listen(t.path, ok));
  try {
    await t.close();
    assert.ok(statSync(t.path).isSocket(), 'the other socket is still at the path');
    await new Promise((ok, fail) => { const probe = connect(t.path); probe.once('connect', () => { probe.destroy(); ok(); }); probe.once('error', fail); });
  } finally {
    await new Promise((ok) => other.close(ok));
  }
});

test('headers for this hop only never travel on: the fixed hop-by-hop names, and every name a Connection header lists, each way', async () => {
  const t = await proxy();
  try {
    const answer = head((await talk(t.path, 'GET http://origin.test/hop HTTP/1.1\r\nHost: origin.test\r\nConnection: close, x-private\r\nX-Private: hop only\r\nProxy-Authorization: Basic aG9wOm9ubHk=\r\nKeep-Alive: timeout=5\r\nX-Kept: yes\r\n\r\n')).got);
    assert.equal(answer.status, 200, answer.line);
    const sent = t.fake.heads.at(-1);
    assert.equal(sent['x-private'], undefined, 'a header the Connection header named stays on the client hop');
    assert.equal(sent['proxy-authorization'], undefined);
    assert.equal(sent['keep-alive'], undefined);
    assert.equal(sent['x-kept'], 'yes', 'an end-to-end header passes');
    assert.doesNotMatch(answer.text, /^x-back:/im, "a header the origin's Connection header named stays on that hop");
    assert.match(answer.text, /^x-kept: yes/im);
  } finally {
    await t.close();
  }
});
