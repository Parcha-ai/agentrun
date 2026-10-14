// The install probe. The parsers run anywhere; the cases that start a Docker box need Docker and the network, and are skipped
// without Docker (set INSTALL_BOX_SKIP=1 to skip them anyway).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { answerNames, attachInstall, dnsNames, installProbe, killBox, outboundOf, parseAnswer, queryName, startInstall } from './dependency-audit/install-box.ts';

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0 && process.env.INSTALL_BOX_SKIP !== '1';
const needsDocker = { skip: docker ? false : 'docker is not available' };

/** A DNS query for `name` as bytes. */
function query(name, type = 1) {
  const labels = name.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]);
  return Uint8Array.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, type, 0, 1]);
}
/** As `strace -xx` prints it. */
const hex = (bytes) => `"${[...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;

test('a DNS query reads as its name, and bytes that are not a query read as nothing', () => {
  assert.equal(queryName(query('registry.npmjs.org')), 'registry.npmjs.org');
  assert.equal(queryName(query('Objects.GitHubUserContent.com', 28)), 'objects.githubusercontent.com');
  assert.equal(queryName(Uint8Array.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03, 0x00, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])), undefined);
  assert.equal(queryName(query('localhost')), undefined);
  const answer = query('registry.npmjs.org');
  answer[2] = 0x81;
  assert.equal(queryName(answer), undefined);
});

test('the names a trace asked the resolver for come from sendto and sendmmsg lines, once each', () => {
  const trace = [
    `812 1791990001.100001 sendto(5, ${hex(query('registry.npmjs.org'))}, 36, MSG_NOSIGNAL, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.11")}, 16) = 36`,
    `812 1791990001.100050 sendmmsg(5, [{msg_hdr={msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base=${hex(query('github.com'))}, iov_len=28}], msg_iovlen=1}, msg_len=28}, {msg_hdr={msg_iov=[{iov_base=${hex(query('github.com', 28))}, iov_len=28}], msg_iovlen=1}, msg_len=28}], 2, MSG_NOSIGNAL) = 2`,
    `813 1791990002.000000 sendto(9, ${hex([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00, 0x03, 0x03, 0x68, 0x65, 0x6c, 0x6c, 0x6f])}, 17, MSG_NOSIGNAL, NULL, 0) = 17`,
  ].join('\n');
  assert.deepEqual([...dnsNames(trace)].sort(), ['github.com', 'registry.npmjs.org']);
});

test('the connections are the first sight of each address and port, oldest first, without loopback, port 0 or DNS', () => {
  const connect = (at, port, ip, family = 'AF_INET') => family === 'AF_INET'
    ? `812 ${at} connect(18, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr(${hex(Buffer.from(ip))})}, 16) = -1 EINPROGRESS (Operation now in progress)`
    : `815 ${at} connect(19, {sa_family=AF_INET6, sin6_port=htons(${port}), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, ${hex(Buffer.from(ip))}), sin6_scope_id=0}, 28) = -1 EINPROGRESS (Operation now in progress)`;
  const trace = [
    connect('1791990001.100000', 53, '213.186.33.99'),
    connect('1791990001.200000', 0, '104.16.4.34'),
    connect('1791990002.500000', 443, '104.16.1.35'),
    connect('1791990001.900000', 443, '2606:4700::6810:123', 'AF_INET6'),
    connect('1791990003.000000', 443, '104.16.1.35'),
    connect('1791990004.000000', 8080, '127.0.0.1'),
    '815 1791990005.000000 connect(22, {sa_family=AF_UNIX, sun_path="/var/run/nscd/socket"}, 110) = -1 ENOENT (No such file or directory)',
    '815 1791990005.500000 connect(24, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("104.16.9.9")}, 16) = 0',
    connect('1791990006.250000', 443, '140.82.121.4'),
  ].join('\n');
  const found = outboundOf(trace, new Map([['104.16.1.35', 'registry.npmjs.org'], ['140.82.121.4', 'github.com']]));
  assert.deepEqual(found, [
    { ip: '2606:4700::6810:123', port: 443, at: 1791990001900 },
    { host: 'registry.npmjs.org', ip: '104.16.1.35', port: 443, at: 1791990002500 },
    { ip: '104.16.9.9', port: 443, at: 1791990005500 },
    { host: 'github.com', ip: '140.82.121.4', port: 443, at: 1791990006250 },
  ]);
});

/** A DNS response for `name`: a CNAME to `target`, then the addresses, the answer names written as compression pointers. */
function answer(name, target, ips, ips6 = []) {
  const labels = (host) => host.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]);
  const question = [...labels(name), 0, 0, 1, 0, 1];
  const records = [];
  if (target) {
    const data = [...labels(target), 0];
    records.push(0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, data.length, ...data);
  }
  for (const ip of ips) records.push(0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ip.split('.').map(Number));
  for (const ip6 of ips6) records.push(0xc0, 12, 0, 28, 0, 1, 0, 0, 0, 60, 0, 16, ...ip6);
  return Uint8Array.from([0x12, 0x34, 0x81, 0x80, 0, 1, 0, (target ? 1 : 0) + ips.length + ips6.length, 0, 0, 0, 0, ...question, ...records]);
}

test('a DNS answer names the question and gives its A and AAAA records, through a CNAME and compression pointers', () => {
  assert.deepEqual(parseAnswer(answer('storage.googleapis.com', undefined, ['173.194.45.207', '142.250.1.2'])), { name: 'storage.googleapis.com', ips: ['173.194.45.207', '142.250.1.2'] });
  assert.deepEqual(parseAnswer(answer('cdn.example.org', 'edge.example.net', ['10.1.2.3'])), { name: 'cdn.example.org', ips: ['10.1.2.3'] });
  assert.deepEqual(parseAnswer(answer('v6.example.org', undefined, [], [[0x26, 0x06, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x68, 0x10, 0x01, 0x23]])), { name: 'v6.example.org', ips: ['2606:4700::6810:123'] });
  // A query, an answer with no address, an error answer and plain data are not answers that name an address.
  assert.equal(parseAnswer(query('registry.npmjs.org')), undefined);
  assert.equal(parseAnswer(answer('nothing.example.org', 'elsewhere.example.net', [])), undefined);
  const failed = answer('missing.example.org', undefined, ['1.2.3.4']);
  failed[3] = 0x83;
  assert.equal(parseAnswer(failed), undefined);
  assert.equal(parseAnswer(Uint8Array.from([0x17, 0x03, 0x03, 0x00, 0x30, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), undefined);
});

test('the trace names an address from the answer the install received, whichever receive call carried it', () => {
  const trace = [
    `812 1791990001.200000 recvfrom(5, ${hex(answer('storage.googleapis.com', undefined, ['173.194.45.207']))}, 2048, 0, NULL, NULL) = 80`,
    `812 1791990001.300000 recvmsg(5, {msg_name=NULL, msg_iov=[{iov_base=${hex(answer('github.com', undefined, ['140.82.112.4']))}, iov_len=2048}], msg_iovlen=1}, 0) = 60`,
    `812 1791990001.400000 recvmmsg(5, [{msg_hdr={msg_iov=[{iov_base=${hex(answer('registry.npmjs.org', 'x.cdn.net', ['104.16.8.34']))}, iov_len=2048}]}, msg_len=70}], 1, 0, NULL) = 1`,
    `812 1791990001.500000 sendto(5, ${hex(query('storage.googleapis.com'))}, 40, 0, NULL, 0) = 40`,
  ].join('\n');
  const names = answerNames(trace);
  assert.deepEqual([...names.entries()].sort(), [['104.16.8.34', 'registry.npmjs.org'], ['140.82.112.4', 'github.com'], ['173.194.45.207', 'storage.googleapis.com']]);
  const connect = (at, ip) => `815 ${at} connect(18, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(${hex(Buffer.from(ip))})}, 16) = -1 EINPROGRESS (Operation now in progress)`;
  const found = outboundOf([connect('1791990002.000000', '173.194.45.207'), connect('1791990003.000000', '9.9.9.9')].join('\n'), names);
  // The address the answers did not name stays unnamed here; the helper asks the resolver again only for such an address.
  assert.deepEqual(found, [{ host: 'storage.googleapis.com', ip: '173.194.45.207', port: 443, at: 1791990002000 }, { ip: '9.9.9.9', port: 443, at: 1791990003000 }]);
  assert.deepEqual([...dnsNames(trace)], ['storage.googleapis.com']);
});

test('without Docker the start throws a typed DOCKER_UNAVAILABLE', async () => {
  await assert.rejects(() => startInstall('is-number', '7.0.0', { docker: '/nonexistent/docker' }), (error) => error.code === 'DOCKER_UNAVAILABLE');
  await assert.rejects(() => attachInstall('0123456789ab', { docker: '/nonexistent/docker' }), (error) => error.code === 'DOCKER_UNAVAILABLE');
});

test('a name or version that is not one is refused before any box', async () => {
  await assert.rejects(() => startInstall('x; touch /tmp/p', '1.0.0'), /not an npm package name/);
  await assert.rejects(() => startInstall('is-number', '1.0.0 && id'), /not a package version/);
});

test('an install in a box: the registry is reached, the script log and the duration come back, and the box is gone after', needsDocker, async () => {
  const label = `install-box-test-${process.pid}`;
  const { boxId } = await startInstall('is-number', '7.0.0', { labels: { run: label } });
  // The caller may be a different process: only the id is needed. A short wait says the install is still going.
  const early = await attachInstall(boxId, { waitMs: 1 });
  assert.ok('running' in early || 'exitCode' in early);
  let result = early;
  while ('running' in result) result = await attachInstall(boxId, { waitMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.seen, 'connections seen by strace');
  assert.equal(typeof result.scriptLog, 'string');
  assert.ok(result.durationMs > 0);
  const registry = result.outbound.find((connection) => connection.host === 'registry.npmjs.org');
  assert.ok(registry, `the registry was reached: ${JSON.stringify(result.outbound)}`);
  assert.equal(registry.port, 443);
  assert.deepEqual([...result.outbound].sort((a, b) => a.at - b.at), result.outbound);
  // The result was read once: the box is removed, and asking again says so.
  assert.deepEqual(await attachInstall(boxId), { gone: true });
  const left = spawnSync('docker', ['ps', '--quiet', '--filter', `label=run=${label}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '');
});

test('a box killed with its machine mid-install is gone, and a fresh box repeats the install', needsDocker, async () => {
  const label = `install-box-kill-${process.pid}`;
  const { boxId } = await startInstall('typescript', '5.4.5', { labels: { run: label } });
  assert.deepEqual(await attachInstall(boxId, { waitMs: 1 }), { running: true });
  assert.equal(await killBox(boxId), true);
  assert.deepEqual(await attachInstall(boxId, { waitMs: 1 }), { gone: true });
  assert.equal(await killBox(boxId), false);
  const left = spawnSync('docker', ['ps', '--all', '--quiet', '--filter', `label=run=${label}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '');
  const again = await installProbe('is-number', '7.0.0');
  assert.equal(again.exitCode, 0);
});

test('an install that downloads a browser from Google storage names that host, from the DNS answer in the trace', needsDocker, async () => {
  const result = await installProbe('puppeteer', '18.2.1', { timeoutMs: 8 * 60_000 });
  assert.equal(result.exitCode, 0, result.scriptLog.slice(-600));
  const hosts = result.outbound.map((connection) => connection.host);
  assert.ok(hosts.includes('registry.npmjs.org'), JSON.stringify(result.outbound));
  assert.ok(hosts.includes('storage.googleapis.com'), `the browser's host is named: ${JSON.stringify(result.outbound)}`);
  assert.match(result.scriptLog, /Chromium .* downloaded/);
});
