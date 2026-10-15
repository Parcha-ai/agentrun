import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accepts, checkResolved, companionDependencies, extraCopies, legOf, lsProblems, parseRange, readWorkspaces, resolvedFrom } from './pi-leg.mjs';

const script = fileURLToPath(new URL('./pi-leg.mjs', import.meta.url));
const repo = dirname(dirname(script));
const scratch = mkdtempSync(join(tmpdir(), 'pi-leg-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const ws = (name, peers = {}, devDependencies = {}, scripts = {}) => ({ name, dir: `/nowhere/${name}`, manifest: { name, peerDependencies: peers, devDependencies, scripts } });
const PI = { '@earendil-works/pi-durable': '>=1.0.4 <1.2.0', '@earendil-works/chord': '>=1.0.4 <1.2.0', '@earendil-works/pi-coding-agent': '*' };
const WIDE = { '@earendil-works/pi-durable': '>=1.0.4 <1.3.0', '@earendil-works/chord': '>=1.0.4 <1.3.0' };

const D = '@earendil-works/pi-durable';
test('a range is read as the comparators the manifests use, and any other shape is refused', () => {
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.2.0', D), true);
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.0.4', D), true);
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.3.0', D), false);
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.0.3', D), false);
  assert.equal(accepts('>=1.0.0 <1.1.0', '1.2.0', D), false);
  assert.equal(accepts('1.1.0', '1.1.0', D), true);
  assert.equal(accepts('1.1.0', '1.2.0', D), false);
  assert.equal(accepts('>1.1.0 <=1.2.0', '1.2.0', D), true);
  for (const range of ['^1.0.0', '~1.1.0', '>=1.0.4 || 2.0.0', '1.x', '>=1.0']) assert.throws(() => parseRange(range, D), /a shape this script does not read/, range);
  assert.throws(() => accepts('>=1.0.4 <1.3.0', '1.2', D), /not a plain x.y.z version/);
});

test("'*' is any version on each package Pi provides, and refused on pi-durable and chord", () => {
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(accepts('*', '1.2.0', name), true, name);
    assert.equal(accepts('*', '9.9.9', name), true, name);
  }
  for (const name of ['@earendil-works/pi-durable', '@earendil-works/chord']) {
    assert.throws(() => parseRange('*', name), new RegExp(`${name} has the range "\\*": only a package Pi provides`), name);
  }
  assert.throws(() => accepts('*', '1.2', '@earendil-works/pi-ai'), /not a plain x.y.z version/);
  const plan = legOf([ws('@parcha/pi-browser', { ...WIDE, '@earendil-works/pi-coding-agent': '*' }), ws('@parcha/pi-vision', { ...WIDE, '@earendil-works/pi-ai': '*' })], '1.2.0');
  assert.deepEqual([plan.leg, plan.out], [['@parcha/pi-browser', '@parcha/pi-vision'], []]);
  assert.throws(() => legOf([ws('@parcha/pi-transport', { '@earendil-works/pi-durable': '*' })], '1.2.0'), /@earendil-works\/pi-durable has the range "\*"/);
});

test('the leg is the pi workspaces whose every pi-family peer accepts the version; the others say which range keeps them out', () => {
  const plan = legOf([ws('@parcha/agentrun-dsl'), ws('@parcha/agentrun-pi', PI), ws('@parcha/pi-durable-disk', WIDE)], '1.2.0');
  assert.deepEqual(plan.pi, ['@parcha/agentrun-pi', '@parcha/pi-durable-disk'], 'a workspace with no pi-family peer is not a pi workspace');
  assert.deepEqual(plan.leg, ['@parcha/pi-durable-disk']);
  assert.deepEqual(plan.out, [{ name: '@parcha/agentrun-pi', why: '@earendil-works/pi-durable >=1.0.4 <1.2.0, @earendil-works/chord >=1.0.4 <1.2.0' }]);
  assert.deepEqual(plan.refused, []);
});

test('a leg workspace that depends on a pi workspace outside the leg is refused: one process would load two pi-durable versions', () => {
  const pi = ws('@parcha/agentrun-pi', WIDE, { '@parcha/pi-durable-disk': '0.1.0' });
  assert.deepEqual(legOf([pi, ws('@parcha/pi-durable-disk', PI)], '1.2.0').refused, [{ name: '@parcha/agentrun-pi', needs: ['@parcha/pi-durable-disk'] }]);
  assert.deepEqual(legOf([pi, ws('@parcha/pi-durable-disk', WIDE)], '1.2.0').refused, []);
  assert.deepEqual(legOf([pi, ws('@parcha/pi-durable-disk', WIDE), ws('@parcha/pi-vision', WIDE)], '1.0.4', ['@parcha/agentrun-pi']).refused,
    [{ name: '@parcha/agentrun-pi', needs: ['@parcha/pi-durable-disk'] }], '--only that leaves the dependency out is refused too');
});

test('--only narrows the leg to named pi workspaces and refuses a name that is not one', () => {
  const all = [ws('@parcha/agentrun-pi', WIDE), ws('@parcha/pi-vision', WIDE), ws('@parcha/agentrun-dsl')];
  const plan = legOf(all, '1.0.4', ['@parcha/agentrun-pi']);
  assert.deepEqual([plan.leg, plan.out], [['@parcha/agentrun-pi'], [{ name: '@parcha/pi-vision', why: 'not asked for (--only)' }]]);
  assert.throws(() => legOf(all, '1.0.4', ['@parcha/agentrun-dsl']), /is not a workspace with a pi-family peer/);
});

test('a module loads the nearest copy above its real directory, as a bare import resolves', () => {
  const root = join(scratch, 'resolve');
  write(join(root, 'node_modules/@earendil-works/chord/package.json'), { name: '@earendil-works/chord', version: '1.1.0' });
  write(join(root, 'packages/pi/node_modules/@earendil-works/chord/package.json'), { name: '@earendil-works/chord', version: '1.2.0' });
  write(join(root, 'packages/pi/package.json'), { name: '@parcha/agentrun-pi' });
  write(join(root, 'packages/disk/package.json'), { name: '@parcha/pi-durable-disk' });
  assert.equal(resolvedFrom(join(root, 'packages/pi'), '@earendil-works/chord').version, '1.2.0');
  assert.equal(resolvedFrom(join(root, 'packages/disk'), '@earendil-works/chord').version, '1.1.0');
  assert.equal(resolvedFrom(join(root, 'packages/disk'), '@earendil-works/pi-tui'), undefined);
});

/** A repository with `workspaces` under packages/, for running the script as CI does. */
function repoOf(name, workspaces) {
  const root = join(scratch, name);
  write(join(root, 'package.json'), { name: 'workspace', private: true, workspaces: ['packages/*'] });
  for (const { manifest } of workspaces) write(join(root, 'packages', manifest.name.split('/')[1], 'package.json'), manifest);
  return root;
}
const leg = (root, ...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...leg.env } });
leg.env = {};

test('the plan names what runs and what does not; --require-all fails while any pi workspace is out, and a refusal always fails', () => {
  const partial = repoOf('partial', [ws('@parcha/agentrun-pi', PI), ws('@parcha/pi-durable-disk', WIDE), ws('@parcha/agentrun-dsl')]);
  const planned = leg(partial, '--pi', '1.2.0', '--plan', '--out', join(partial, 'out/leg.json'));
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /^pi 1\.2\.0: in the leg: @parcha\/pi-durable-disk$/m);
  assert.match(planned.stdout, /^pi 1\.2\.0: not in the leg: @parcha\/agentrun-pi \(@earendil-works\/pi-durable >=1\.0\.4 <1\.2\.0, @earendil-works\/chord >=1\.0\.4 <1\.2\.0\)$/m);
  const strict = leg(partial, '--pi', '1.2.0', '--plan', '--require-all');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /FAILED: --require-all, and 1 pi workspace\(s\) are not in the leg/);
  const all = repoOf('all', [ws('@parcha/agentrun-pi', WIDE), ws('@parcha/pi-durable-disk', WIDE)]);
  assert.equal(leg(all, '--pi', '1.2.0', '--plan', '--require-all').status, 0);
  const refused = repoOf('refused', [ws('@parcha/agentrun-pi', WIDE, { '@parcha/pi-durable-disk': '0.1.0' }), ws('@parcha/pi-durable-disk', PI)]);
  const out = leg(refused, '--pi', '1.2.0', '--plan');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /REFUSED: @parcha\/agentrun-pi depends on @parcha\/pi-durable-disk, which is not in the leg/);
});

test('an empty leg installs nothing and passes, saying so; an unread range shape, a missing version or no mode stops the script', () => {
  const none = repoOf('none', [ws('@parcha/agentrun-pi', PI)]);
  const empty = leg(none, '--pi', '1.2.0', '--scratch', '--npm', 'false');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /in the leg: none/);
  assert.doesNotMatch(empty.stdout, /^\$ /m, 'no command ran');
  const caret = repoOf('caret', [ws('@parcha/agentrun-pi', { '@earendil-works/pi-durable': '^1.0.4' })]);
  const unread = leg(caret, '--pi', '1.2.0', '--plan');
  assert.equal(unread.status, 2);
  assert.match(unread.stderr, /a shape this script does not read/);
  assert.equal(leg(none).status, 2);
  const neither = leg(none, '--pi', '1.2.0');
  assert.equal(neither.status, 2);
  assert.match(neither.stderr, /give --plan \(change nothing\) or --scratch/);
});

test('the install refuses an npm other than the pinned one before it changes anything', () => {
  const root = repoOf('npm', [ws('@parcha/pi-durable-disk', WIDE, { '@earendil-works/pi-durable': '1.1.0' })]);
  const fake = join(root, 'fake-npm.mjs');
  write(fake, 'console.log("10.9.2");\n');
  const out = leg(root, '--pi', '1.2.0', '--scratch', '--npm', `${process.execPath} ${fake}`);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAILED: the install needs npm 11\.21\.0; .* is 10\.9\.2/);
});

test("every pi-family peer range in this repository is one the script reads", () => {
  const workspaces = readWorkspaces(repo);
  for (const version of ['1.0.4', '1.1.0', '1.2.0']) assert.doesNotThrow(() => legOf(workspaces, version));
});

/** A package directory `node_modules/<name>` under `at`, at `version`. */
const pkg = (at, name, version) => write(join(at, 'node_modules', name, 'package.json'), { name, version });
const DURABLE = '@earendil-works/pi-durable', CHORD = '@earendil-works/chord', AI = '@earendil-works/pi-ai', TUI = '@earendil-works/pi-tui';

test('the resolved check names a wrong direct version, a wrong version pi-durable loads, and a missing package', () => {
  const root = join(scratch, 'resolved');
  for (const name of [DURABLE, AI]) pkg(root, name, '1.2.0');
  pkg(root, CHORD, '1.1.0');
  const dir = join(root, 'packages/pi');
  pkg(dir, CHORD, '1.2.0');
  pkg(dir, AI, '1.1.0');
  const workspace = { name: '@parcha/agentrun-pi', dir, manifest: { devDependencies: { [DURABLE]: '1.2.0', [CHORD]: '1.2.0', [AI]: '1.2.0', [TUI]: '1.2.0' } } };
  const { wrong } = checkResolved(workspace, '1.2.0');
  assert.deepEqual(wrong.map((row) => [row.from, row.name, row.version]), [
    ['@parcha/agentrun-pi', AI, '1.1.0'],
    ['@parcha/agentrun-pi', TUI, undefined],
    ["@parcha/agentrun-pi's pi-durable", CHORD, '1.1.0'],
  ]);
  const sound = { ...workspace, manifest: { devDependencies: { [DURABLE]: '1.2.0' } } };
  pkg(root, CHORD, '1.2.0');
  assert.deepEqual(checkResolved(sound, '1.2.0').wrong, []);
});

test('two directories for one family package are extra copies; one directory, or none resolved, is not', () => {
  assert.deepEqual(extraCopies([
    { name: DURABLE, path: '/a/node_modules/x' }, { name: DURABLE, path: '/b/node_modules/x' },
    { name: CHORD, path: '/r/node_modules/c' }, { name: CHORD, path: '/r/node_modules/c' }, { name: AI },
  ]), [{ name: DURABLE, paths: ['/a/node_modules/x', '/b/node_modules/x'] }]);
});

test("npm ls fails the leg on a launch error, a nonzero exit or a broken edge, and passes a sound tree", () => {
  assert.deepEqual(lsProblems({ status: 0, stdout: 'workspace@1.0.0\n└── @earendil-works/pi-durable@1.2.0\n', stderr: '' }), []);
  assert.deepEqual(lsProblems({ error: new Error('spawn npx ENOENT'), status: null }), ['npm ls did not run: spawn npx ENOENT']);
  assert.deepEqual(lsProblems({ status: 1, stdout: '', stderr: 'npm error code ELSPROBLEMS\nnpm error invalid: chord\n' }), ['npm ls exited 1: npm error code ELSPROBLEMS / npm error invalid: chord']);
  assert.deepEqual(lsProblems({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }), ['npm ls exited on SIGKILL']);
  assert.equal(lsProblems({ status: 1, stdout: '├── @earendil-works/chord@1.0.4 invalid: "1.1.0" from packages/pi\n', stderr: '' }).length, 2);
});

/** A repository whose two leg workspaces each hold their own pi-durable 1.2.0, and an npm that installs nothing and
 *  answers `ls` as FAKE_LS says, so the run reaches the checks on the tree as it was laid out. */
function twoCopies(name) {
  const root = repoOf(name, [ws('@parcha/pi-vision', WIDE, { [DURABLE]: '1.2.0' }), ws('@parcha/pi-transport', WIDE, { [DURABLE]: '1.2.0' })]);
  for (const dir of ['pi-vision', 'pi-transport']) pkg(join(root, 'packages', dir), DURABLE, '1.2.0');
  for (const name of [CHORD, AI]) pkg(root, name, '1.2.0');
  const npm = join(root, 'fake-npm.mjs');
  write(npm, [
    "if (process.argv.includes('--version')) { console.log('11.21.0'); process.exit(0); }",
    "if (process.argv[2] === 'install') process.exit(0);",
    "if (process.argv[2] === 'ls') { if (process.env.FAKE_LS === 'fail') { console.error('npm error code ELSPROBLEMS'); process.exit(1); } console.log('workspace@0.0.0'); process.exit(0); }",
    'process.exit(9);',
  ].join('\n'));
  return { root, npm: `${process.execPath} ${npm}` };
}

test('a run whose tree holds two copies of a family package fails before it builds, naming both', () => {
  const { root, npm } = twoCopies('two-copies');
  const out = leg(root, '--pi', '1.2.0', '--scratch', '--npm', npm);
  assert.equal(out.status, 1, out.stderr);
  const line = out.stdout.split('\n').find((text) => text.includes('FAILED: the leg loads 2 copies of @earendil-works/pi-durable: '));
  assert.ok(line, out.stdout);
  for (const dir of ['pi-vision', 'pi-transport']) assert.ok(line.includes(`packages/${dir}/node_modules/@earendil-works/pi-durable`), line);
  assert.doesNotMatch(out.stdout, /\$ npm run build/);
});

test('a run whose npm ls fails stops before it builds, with what npm said', () => {
  const { root, npm } = twoCopies('ls-fails');
  leg.env = { FAKE_LS: 'fail' };
  try {
    const out = leg(root, '--pi', '1.2.0', '--scratch', '--npm', npm);
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stdout, /npm ls: npm ls exited 1: npm error code ELSPROBLEMS/);
    assert.match(out.stdout, /FAILED: npm ls reports 1 problem\(s\)/);
    assert.doesNotMatch(out.stdout, /\$ npm run build/);
  } finally { leg.env = {}; }
});

// The coding agent imports pi-codemode, which a later minor changed: the leg pins it with the coding agent, not at the lockfile's version.
const CODING = '@earendil-works/pi-coding-agent', CODEMODE = '@earendil-works/pi-codemode', MCP = '@earendil-works/pi-mcp';
const codingAgent = (at, version) => write(join(at, 'node_modules', CODING, 'package.json'), { name: CODING, version, dependencies: { [CODEMODE]: `^${version}`, [MCP]: `^${version}`, [AI]: `^${version}` } });

test('the companions of the installed family packages are the @earendil-works packages outside the family they depend on', () => {
  const root = join(scratch, 'companions');
  codingAgent(root, '1.0.4');
  pkg(root, DURABLE, '1.0.4');
  assert.deepEqual(companionDependencies(root, [CODING, DURABLE, '@earendil-works/pi-tui']), [CODEMODE, MCP]);
  assert.deepEqual(companionDependencies(root, [DURABLE]), []);
});

test('the resolved check names a companion the lockfile left at a newer minor than the coding agent', () => {
  const root = join(scratch, 'companion-drift');
  const dir = join(root, 'packages/pi');
  codingAgent(dir, '1.0.4');
  pkg(root, CODEMODE, '1.2.0'); pkg(root, MCP, '1.0.4');
  const workspace = { name: '@parcha/agentrun-pi', dir, manifest: { devDependencies: { [CODING]: '1.0.4' } } };
  assert.deepEqual(checkResolved(workspace, '1.0.4').wrong.map((row) => [row.from, row.name, row.version]), [["@parcha/agentrun-pi's pi-coding-agent", CODEMODE, '1.2.0']]);
  pkg(root, CODEMODE, '1.0.4');
  assert.deepEqual(checkResolved(workspace, '1.0.4').wrong, []);
});

/** A repository whose lockfile holds pi-codemode 1.2.0, and an npm that lays out what an install of the coding agent at the leg's
 *  version brings (its dependencies on pi-codemode and pi-mcp at the leg's version) and installs a package at the version it is
 *  asked for only when FAKE_PINS says it honors pins; every call is logged. */
function lockedCodemode(name) {
  const root = repoOf(name, [ws('@parcha/agentrun-pi', WIDE, { [CODING]: '1.1.0' })]);
  pkg(root, CODEMODE, '1.2.0'); pkg(root, MCP, '1.2.0');
  const npm = join(root, 'fake-npm.mjs');
  write(npm, [
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
    "const root = process.cwd(); const at = (name, version, extra = {}) => { mkdirSync(`${root}/node_modules/${name}`, { recursive: true }); writeFileSync(`${root}/node_modules/${name}/package.json`, JSON.stringify({ name, version, ...extra })); };",
    "if (process.argv.includes('--version')) { console.log('11.21.0'); process.exit(0); }",
    "if (process.argv[2] === 'install') {",
    "  appendFileSync(`${root}/calls.log`, process.argv.slice(3).join(' ') + '\\n');",
    "  for (const spec of process.argv.slice(3).filter((arg) => arg.startsWith('@'))) {",
    "    const [name, version] = [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)];",
    "    if (name.endsWith('pi-coding-agent')) at(name, version, { dependencies: { '@earendil-works/pi-codemode': `^${version}`, '@earendil-works/pi-mcp': `^${version}` } });",
    "    else if (name.endsWith('pi-codemode') || name.endsWith('pi-mcp')) at(name, version);",
    "  }",
    "  process.exit(0);",
    "}",
    "if (process.argv[2] === 'ls') { console.log('workspace@0.0.0'); process.exit(0); }",
    'process.exit(9);',
  ].join('\n'));
  return { root, npm: `${process.execPath} ${npm}` };
}

test('a leg pins pi-codemode and pi-mcp at the coding agent\'s version before it checks, so a lockfile on a newer minor cannot reach it', () => {
  const { root, npm } = lockedCodemode('locked-codemode');
  leg.env = {};
  const out = leg(root, '--pi', '1.0.4', '--scratch', '--npm', npm);
  const calls = readFileSync(join(root, 'calls.log'), 'utf8');
  assert.match(calls, /@earendil-works\/pi-coding-agent@1\.0\.4/);
  assert.match(calls, /@earendil-works\/pi-codemode@1\.0\.4 @earendil-works\/pi-mcp@1\.0\.4/);
  // The leg's checks passed: it went on to the build, which the empty fixture cannot run.
  assert.match(out.stdout, /resolved from @parcha\/agentrun-pi's pi-coding-agent: @earendil-works\/pi-codemode 1\.0\.4/);
  assert.doesNotMatch(out.stdout, /FAILED: @parcha\/agentrun-pi resolves/);
});

test('a companion that stays at the lockfile\'s version fails the leg before it builds, naming it', () => {
  const { root, npm } = lockedCodemode('stale-codemode');
  const stale = join(root, 'stale-npm.mjs');
  write(stale, readFileSync(join(root, 'fake-npm.mjs'), 'utf8').replace("else if (name.endsWith('pi-codemode') || name.endsWith('pi-mcp')) at(name, version);", ''));
  const out = leg(root, '--pi', '1.0.4', '--scratch', '--npm', `${process.execPath} ${stale}`);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /FAILED: @parcha\/agentrun-pi resolves .*@earendil-works\/pi-codemode 1\.2\.0 \(from @parcha\/agentrun-pi's pi-coding-agent\)/);
  assert.doesNotMatch(out.stdout, /\$ npm run build/);
});
