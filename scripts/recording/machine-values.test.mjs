// Every committed recording and fixture is checked, on the machine the check runs on, for that machine's own values (read
// here at run time, never written in the repository: its host name, boot id, home directory and tailnet addresses) and
// for the scanner's credential shapes. A fixture cut on a machine fails the check on that machine before it is pushed; a
// finding names the file and the kind, never the value. On CI it checks the runner's own values, which is harmless.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEXT_FILE, credentialInFile, machineValueIn, machineValues, readMachine } from '../../examples/reference/scan.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'dist']);
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? (SKIP.has(entry.name) ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)]));

/** Each .jsonl changed since the branch left origin/main, committed, staged or never staged, when there is a git checkout
 *  with that ref: a hand-folded fixture never went through --record's scan. Git's names are read NUL-separated (`-z`), so
 *  a name git would quote (`docs/café.jsonl`) is read as it is. */
const changedJsonl = (base) => {
  const git = (...args) => execFileSync('git', args, { cwd: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const from = git('merge-base', 'origin/main', 'HEAD').trim();
    const names = [...git('diff', '--name-only', '-z', '--diff-filter=AMR', from, '--', '*.jsonl').split('\0'), ...git('ls-files', '--others', '--exclude-standard', '-z', '--', '*.jsonl').split('\0')];
    return names.filter(Boolean).map((file) => join(base, file)).filter(existsSync);
  } catch { return []; }
};

/** Every file of a recording or a fixture under `base`: the viewer's recordings and test fixtures, the recording scripts'
 *  fixtures, every `fixtures/` and `recordings/` directory under examples/, and each changed .jsonl. */
const recordedFiles = (base) => {
  const dirs = ['apps/viewer/recordings', 'apps/viewer/test/fixtures', 'scripts/recording/fixtures'].map((dir) => join(base, dir)).filter(existsSync);
  const nested = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
    .flatMap((entry) => (entry.name === 'fixtures' || entry.name === 'recordings' ? [join(dir, entry.name)] : nested(join(dir, entry.name))));
  if (existsSync(join(base, 'examples'))) dirs.push(...nested(join(base, 'examples')));
  return [...new Set([...dirs.flatMap(walk), ...changedJsonl(base)])].sort();
};

/** Each file that holds one of `values` or a credential shape, as `{ file, kind }`: the file relative to `base`, never the value. */
const findingsIn = (base, values) => recordedFiles(base).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  const kind = machineValueIn(text, values) ?? (TEXT_FILE.test(file) ? credentialInFile(file, text) : undefined);
  return kind ? [{ file: relative(base, file), kind }] : [];
});
const report = (found) => found.map(({ file, kind }) => `${file}: ${kind}`).join('\n');

test('no committed recording or fixture holds this machine\'s own values or a credential shape', () => {
  assert.ok(recordedFiles(root).some((file) => file.startsWith(join(root, 'apps/viewer/recordings'))), 'the bundled recordings are among the files checked');
  const found = findingsIn(root, machineValues());
  assert.deepEqual(found, [], report(found));
});

/** Whether this machine's own name is one no scan looks for (under 4 characters, or `localhost`). */
const generic = hostname().length < 4 || hostname() === 'localhost';
/** A host line as the recorder writes one, the holder's host and boot id given. */
const runJsonLine = (host, bootId) => `${JSON.stringify({ channel: 'live', source: 'host', kind: 'run.json', t: 1, seq: 0, data: { gen: 1, holder: { driver: 'disk', host, bootId, pid: 1, since: 't' } } })}\n`;

test('a fixture cut on this machine fails here by file and kind, never by value; with stand-ins for its values it passes', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'machine-values-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const values = machineValues();
  if (generic) return t.skip('this machine\'s host name is too short or generic to look for');
  const write = (path, text) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text); };
  // The same fixture in two of the places a fixture lives: the viewer's test fixtures, and an example's.
  for (const path of ['apps/viewer/test/fixtures/cut-here/events.jsonl', 'examples/some-demo/fixtures/cut-here/events.jsonl']) write(path, runJsonLine(hostname(), 'boot-1'));
  const found = findingsIn(base, values);
  assert.deepEqual(found, [
    { file: join('apps/viewer/test/fixtures/cut-here/events.jsonl'), kind: 'host name' },
    { file: join('examples/some-demo/fixtures/cut-here/events.jsonl'), kind: 'host name' },
  ]);
  assert.ok(!report(found).includes(hostname()), 'a finding never says the value');
  for (const path of ['apps/viewer/test/fixtures/cut-here/events.jsonl', 'examples/some-demo/fixtures/cut-here/events.jsonl']) write(path, runJsonLine('host-1', 'boot-1'));
  assert.deepEqual(findingsIn(base, values), []);
});

test('a .jsonl changed since the branch left origin/main is checked wherever it is, staged or not, whatever its name', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'machine-values-git-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const values = machineValues();
  if (generic) return t.skip('this machine\'s host name is too short or generic to look for');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: base, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(base, 'README.md'), 'a repository\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(base, 'docs'));
  // A hand-folded fixture, never staged; then committed, beside one whose name git quotes in its plain output.
  writeFileSync(join(base, 'docs', 'folded.jsonl'), runJsonLine(hostname(), 'boot-1'));
  assert.deepEqual(findingsIn(base, values), [{ file: join('docs', 'folded.jsonl'), kind: 'host name' }], 'before it is staged');
  writeFileSync(join(base, 'docs', 'café.jsonl'), runJsonLine(hostname(), 'boot-1'));
  git('add', 'docs');
  git('commit', '-q', '-m', 'hand-folded fixtures');
  assert.deepEqual(findingsIn(base, values), [{ file: join('docs', 'café.jsonl'), kind: 'host name' }, { file: join('docs', 'folded.jsonl'), kind: 'host name' }]);
});

test('a check run as root passes clean fixtures: /root is where a workflow\'s paths start, and a home every machine shares names no one', () => {
  for (const homedir of ['/root', '/root/', '/var/root', '/']) {
    const values = machineValues({ ...readMachine(), homedir });
    assert.ok(!values.some((each) => each.kind === 'home directory'), homedir);
    const found = findingsIn(root, values);
    assert.deepEqual(found, [], `${homedir}: ${report(found)}`);
  }
  assert.ok(machineValues({ hostname: 'x', bootId: '', homedir: '/srv/someone', addresses: [] }).some((each) => each.kind === 'home directory'), 'a home that names someone is taken');
  assert.equal(machineValueIn('{"path":"/root/steps/0"}', machineValues({ hostname: 'x', bootId: '', homedir: '/root', addresses: [] })), undefined);
});

test('a name stands whole: a hyphen or a dot with more name after it goes on (build-agent, ci.build), a path or a sentence may follow', () => {
  const values = [{ kind: 'host name', value: 'build' }];
  for (const text of ['"build-agent"', '"agent-build"', '"ci.build"', '"build.other.org"', 'rebuild', 'build2']) assert.equal(machineValueIn(text, values), undefined, text);
  for (const text of ['"host":"build"', 'on build.', 'build:8080', 'build/x', '(build)']) assert.equal(machineValueIn(text, values), 'host name', text);
  const home = [{ kind: 'home directory', value: '/srv/someone' }];
  for (const text of ['/srv/someone2', '/srv/someone.bak', '/mnt/srv/someone']) assert.equal(machineValueIn(text, home), undefined, text);
  for (const text of ['"/srv/someone/work"', 'HOME=/srv/someone', '"/srv/someone"']) assert.equal(machineValueIn(text, home), 'home directory', text);
  const address = [{ kind: 'tailnet address', value: '100.64.1.2' }];
  for (const text of ['100.64.1.23', '1100.64.1.2', '5.100.64.1.2', '100.64.1.2.9']) assert.equal(machineValueIn(text, address), undefined, text);
  for (const text of ['"100.64.1.2"', '100.64.1.2:443', 'at 100.64.1.2.']) assert.equal(machineValueIn(text, address), 'tailnet address', text);
});

test('every kind of value this machine has is looked for: its names, boot id, home directory and tailnet addresses', () => {
  // Read here on their own, so a scanner that stops reading one of them fails instead of passing quietly.
  const own = [];
  for (const name of [hostname(), hostname().split('.')[0]]) if (name.length >= 4 && name !== 'localhost') own.push(['host name', name]);
  let boot = existsSync('/proc/sys/kernel/random/boot_id') ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : '';
  if (!boot && process.platform === 'darwin') boot = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim();
  if (boot) own.push(['boot id', boot]);
  const home = userInfo().homedir;
  if (home.length >= 4 && !['/root', '/var/root'].includes(home.replace(/\/+$/, ''))) own.push(['home directory', home]);
  for (const addresses of Object.values(networkInterfaces())) for (const { address } of addresses ?? []) if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) own.push(['tailnet address', address]);
  const values = machineValues();
  for (const [kind, value] of own) assert.equal(machineValueIn(runJsonLine('host-1', 'boot-1').replace('boot-1', value), values), kind, kind);
});

test('each of this machine\'s values is found where a recording would hold it, and never inside a longer name or number', () => {
  const values = machineValues();
  for (const { kind, value } of values) {
    assert.equal(machineValueIn(`{"at":"${value}"}`, values), kind, kind);
    assert.equal(machineValueIn(`{"at":"${value}/x"}`, values), kind, `${kind} before a slash`);
    assert.equal(machineValueIn(`{"at":"z${value}0"}`, [{ kind, value }]), undefined, `${kind} inside a longer token`);
  }
  assert.equal(machineValueIn(runJsonLine('host-1', 'boot-1'), values), undefined);
});
