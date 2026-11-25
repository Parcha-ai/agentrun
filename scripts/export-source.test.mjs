import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const exporter = await readFile(new URL('./export-source.mjs', import.meta.url));
const machinePathRule = await readFile(new URL('./machine-path.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pnpmLockReader = await readFile(new URL('./pnpm-lock.mjs', import.meta.url));
const npmCommand = await readFile(new URL('./npm-command.mjs', import.meta.url));
const WORKSPACES = ['dsl', 'jev', 'pi-browser', 'import', 'web', 'serve', 'decisions', 'computer', 'client', 'run-adapters', 'run-adapters-claude-agent', 'run-adapters-codex', 'run-adapters-acp', 'agentrun'];

// The fixture's dependencies, written as pnpm writes them (JSON is YAML): `importers` maps a directory to its manifest's
// dependency fields, `{ field: { name: version } }`, each resolved as written; `packages` maps `name@version` to its own
// `dependencies` (resolved as written), peers, `optional` and `license`, which goes to scripts/dependency-licenses.json.
// Every workspace package has a manifest and an importer.
async function writeDependencies(write, { importers = {}, packages = {} } = {}) {
  const resolved = deps => deps && Object.fromEntries(Object.entries(deps).map(([name, version]) => [name, { specifier: version, version }]));
  const lock = { lockfileVersion: '9.0', importers: {}, packages: {}, snapshots: {} };
  for (const dir of ['.', ...WORKSPACES.map(name => `packages/${name}`)]) {
    const { peerDependencies, peerDependenciesMeta, ...fields } = importers[dir] ?? {};
    lock.importers[dir] = Object.fromEntries(Object.entries(fields).map(([field, deps]) => [field, resolved(deps)]));
    if (dir !== '.') await write(`${dir}/package.json`, JSON.stringify({ name: `@fixture/${dir.slice('packages/'.length)}`, version: '0.0.0', ...fields, peerDependencies, peerDependenciesMeta }));
  }
  const licenses = {};
  for (const [key, { dependencies, peerDependencies, peerDependenciesMeta, optional, license }] of Object.entries(packages)) {
    lock.packages[key] = { resolution: { integrity: `sha512-${key}` }, peerDependencies, peerDependenciesMeta };
    lock.snapshots[key] = { dependencies, optional };
    if (license !== undefined) licenses[key] = license;
  }
  await write('pnpm-lock.yaml', JSON.stringify(lock));
  await write('scripts/dependency-licenses.json', JSON.stringify(licenses));
}

test('connector source and notices ship without local worker state or Python build output', async t => {
  const f = await fixture(t);
  const sources = ['connector/pyproject.toml', 'connector/README.md', 'connector/LICENSE', 'connector/NOTICE', 'connector/src/agentrun_cli/remote.py'];
  const privateFiles = ['connector/.venv/pyvenv.cfg', 'connector/build/lib/agentrun_cli/remote.py', 'connector/.agentrun/remote.json', 'connector/dist/receipt.json', 'connector/src/agentrun_cli/__pycache__/remote.pyc'];
  for (const path of sources) await f.write(path, '# Connector source fixture\n');
  for (const path of privateFiles) await f.write(path, 'PRIVATE_CONNECTOR_STATE\n');
  await f.run();
  const listing = await f.listing();
  for (const path of sources) assert.ok(listing.includes(`agentrun-dsl-source/${path}\n`), `${path} is included`);
  for (const path of privateFiles) assert.ok(!listing.includes(`agentrun-dsl-source/${path}`), `${path} is excluded`);
});

test('the eve cookbook exports its source mount without local sessions or compiled credentials', async t => {
  const f = await fixture(t);
  const privateFiles = ['examples/eve-learning/.eve/.workflow-data/session.json',
    'examples/eve-learning/.output/server/index.mjs', 'examples/eve-learning/.vercel/project.json',
    'examples/eve-learning/agent/extensions/agentrun.ts'];
  for (const path of privateFiles) await f.write(path, 'PRIVATE_EVE_FIXTURE\n');
  await f.write('examples/eve-learning/connection/agentrun.ts', 'export const mount = true;\n');
  await f.run();
  const listing = await f.listing();
  assert.ok(listing.includes('agentrun-dsl-source/examples/eve-learning/connection/agentrun.ts'));
  for (const path of privateFiles) assert.ok(!listing.includes(`agentrun-dsl-source/${path}`), path);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-source-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, content = 'fixture\n') => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write('scripts/export-source.mjs', exporter);
  await write('scripts/machine-path.mjs', machinePathRule);
  await write('scripts/pnpm-lock.mjs', pnpmLockReader);
  await write('scripts/npm-command.mjs', npmCommand);
  // The reader's yaml, as the repository's node_modules holds it.
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
  await write('package.json', JSON.stringify({ name: 'fixture', private: true }));
  await writeDependencies(write);
  await write('docs/guide.md', '# Public fixture\n');
  await write('packages/dsl/schema/workflow.schema.json', '{}\n');
  const run = (...args) => exec(process.execPath, [join(root, 'scripts/export-source.mjs'), ...args], { cwd: root });
  const listing = async () => (await exec('tar', ['-tzf', join(root, '.release/agentrun-dsl-source.tar.gz')])).stdout;
  return { root, write, run, listing, dependencies: spec => writeDependencies(write, spec) };
}

test('source archives exclude website files, build output, and private review state', async t => {
  const f = await fixture(t);
  const excluded = [
    '.desloppify/results.json', '.impeccable/critique.md', '.cascade/evidence.json',
    'docs/.desloppify/results.json', 'packages/dsl/.impeccable/critique.md',
    'docs/.review/findings.json', 'examples/.reviews/notes.md', 'docs/candidate.review.json',
    'packages/dsl/scorecard.png', 'packages/jev/scorecard.png',
    'site/index.html', 'site/dist/index.html', 'site/dist/assets/wordmark.webm',
    'site/dist/downloads/agentrun-dsl-source.tar.gz',
    'packages/dsl/site/index.html', 'packages/dsl/dist/index.js',
  ];
  for (const path of excluded) await f.write(path, 'PRIVATE_REVIEW_FIXTURE\n');
  await f.write('examples/public.mjs', 'export const value = 42;\n');
  await f.run();
  const firstListing = await f.listing();
  assert.match(firstListing, /agentrun-dsl-source\/examples\/public\.mjs/);
  for (const path of excluded) assert.ok(!firstListing.includes(`agentrun-dsl-source/${path}`), path);
  assert.doesNotMatch(firstListing, /\/(?:site|dist)\//);
  const archive = await readFile(join(f.root, '.release/agentrun-dsl-source.tar.gz'));
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.publicationReady, false);
  assert.equal(receipt.archive.sha256, hash(archive));
  assert.ok(!('siteDownload' in receipt));
  assert.ok(!receipt.files.some(file => /(?:^|\/)(?:site|dist)\//.test(file.path)));
  await f.run();
  assert.deepEqual(await readFile(join(f.root, '.release/agentrun-dsl-source.tar.gz')), archive);
  assert.equal(await f.listing(), firstListing);
});

test('a *.local.* file is excluded and a source file named local.ts is archived', async t => {
  const f = await fixture(t);
  // A package's module may be named local.ts (a `./box/*` export resolving `./box/local` to src/box/local.ts, which a
  // host imports): a source archive without it does not build. Only a name with `.local` after something (`*.local.*`, `*.local`) is a machine's own file: a
  // directory named `local` and a name that merely starts with `.localhost` are source too.
  const archived = ['packages/serve/src/box/local.ts', 'packages/dsl/src/local.mjs', 'packages/dsl/src/local/index.mjs', 'examples/foo.localhost.ts'];
  const excluded = ['packages/serve/examples/hands.local.json', 'docs/settings.local.md', 'examples/notes.local', 'examples/.env.local', 'packages/dsl/.env.local.json'];
  for (const path of archived) await f.write(path, 'export const box = 1;\n');
  for (const path of excluded) await f.write(path, 'MACHINE_LOCAL_FIXTURE\n');
  await f.run();
  const listing = await f.listing();
  for (const path of archived) assert.ok(listing.includes(`agentrun-dsl-source/${path}`), `${path} is archived`);
  for (const path of excluded) assert.ok(!listing.includes(`agentrun-dsl-source/${path}`), `${path} is excluded`);
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(receipt.exclusions.includes('*.local.*'));
});

test('a .parcha/ directory anywhere in the tree is left out, and its extensionless files do not stop the export', async t => {
  const f = await fixture(t);
  // A session hook on a developer machine writes .parcha/checkpoint-counter in whatever directory a command runs from.
  const excluded = ['apps/console/.parcha/checkpoint-counter', 'packages/serve/.parcha/checkpoint-counter', 'docs/.parcha/state.json'];
  for (const path of excluded) await f.write(path, '7\n');
  await f.write('packages/dsl/src/parcha.mjs', 'export const name = 1;\n');
  await f.run();
  const listing = await f.listing();
  for (const path of excluded) assert.ok(!listing.includes(`agentrun-dsl-source/${path}`), `${path} is excluded`);
  assert.ok(listing.includes('agentrun-dsl-source/packages/dsl/src/parcha.mjs'), 'a source file named parcha is archived');
});

test('a review file (*.review.*) is excluded and source named review is archived', async t => {
  const f = await fixture(t);
  // A review file is a file named `<name>.review.<ext>`, like the author's `<n>.review.json` beside each candidate; it and the
  // `.review`/`.reviews` directories are review state. A module named review.ts, its test, a skill directory named `review`
  // and a file inside a directory whose name looks like a review file are source.
  const archived = ['packages/serve/src/review.ts', 'packages/serve/test/review.test.mjs', 'packages/dsl/skills/review/SKILL.md', 'docs/x.review.y/notes.md'];
  const excluded = ['examples/out/candidate-1/001.review.json', 'docs/candidate.review.json', 'docs/notes.review.md', 'docs/.review/findings.json', 'examples/.reviews/notes.md'];
  for (const path of archived) await f.write(path, 'export const review = 1;\n');
  for (const path of excluded) await f.write(path, 'PRIVATE_REVIEW_FIXTURE\n');
  await f.run();
  const listing = await f.listing();
  for (const path of archived) assert.ok(listing.includes(`agentrun-dsl-source/${path}`), `${path} is archived`);
  for (const path of excluded) assert.ok(!listing.includes(`agentrun-dsl-source/${path}`), `${path} is excluded`);
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(receipt.exclusions.includes('*.review.*'));
});

test('an audit finding blocks the source archive without exposing its content', async t => {
  const f = await fixture(t);
  const fakeSecret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write('examples/unsafe.txt', fakeSecret);
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Source export blocked/);
    assert.ok(!error.stderr.includes(fakeSecret));
    return true;
  });
  await assert.rejects(access(join(f.root, '.release/agentrun-dsl-source.tar.gz')));
  const receipt = await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8');
  assert.equal(JSON.parse(receipt).status, 'failed');
  assert.ok(!receipt.includes(fakeSecret));
});

test('the removed website output flag is rejected before writing artifacts', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('--site-download'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Usage: node scripts\/export-source\.mjs \[--inventory-only \| --licenses\]/);
    return true;
  });
  await assert.rejects(access(join(f.root, '.release')));
  await assert.rejects(access(join(f.root, 'site')));
  await assert.rejects(access(join(f.root, 'docs/dependencies.md')));
});

test('root and package license notices are scanned and retained byte-for-byte', async t => {
  const f = await fixture(t);
  const notices = ['LICENSE', 'NOTICE'].flatMap(name => [name, ...['dsl', 'jev', 'import', 'web', 'serve', 'run-adapters-acp'].map(pkg => `packages/${pkg}/${name}`)]);
  for (const path of notices) await f.write(path, `Notice fixture: ${path}\n`);
  await f.run();
  for (const path of notices) {
    const archived = await exec('tar', ['-xOf', join(f.root, '.release/agentrun-dsl-source.tar.gz'), `agentrun-dsl-source/${path}`]);
    assert.equal(archived.stdout, `Notice fixture: ${path}\n`);
  }
  const secret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write('packages/serve/NOTICE', secret);
  await assert.rejects(f.run(), /Source export blocked/);
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.findings.some(finding => finding.path === 'packages/serve/NOTICE'));
});

test('contributor guidance at the root is archived and receipted; unlisted root files are skipped', async t => {
  const f = await fixture(t);
  const guidance = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'CLAUDE.md'];
  for (const path of guidance) await f.write(path, `Guidance fixture: ${path}\n`);
  await f.write('UNLISTED.md', 'Unlisted root fixture\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  for (const path of guidance) {
    const archived = await exec('tar', ['-xOf', join(f.root, '.release/agentrun-dsl-source.tar.gz'), `agentrun-dsl-source/${path}`]);
    assert.equal(archived.stdout, `Guidance fixture: ${path}\n`);
    assert.ok(receipt.files.some(file => file.path === path), path);
  }
  assert.doesNotMatch(await f.listing(), /UNLISTED\.md/);
  assert.ok(!receipt.files.some(file => file.path === 'UNLISTED.md'));
});

test('formal model sources are archived and scanned as text; an unreviewed file type still stops the export', async t => {
  const f = await fixture(t);
  const models = ['spec/model/Model.tla', 'spec/model/Model.cfg'];
  await f.write(models[0], '---- MODULE Model ----\n====\n');
  await f.write(models[1], 'SPECIFICATION Spec\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  const listing = await f.listing();
  for (const path of models) {
    assert.ok(listing.includes(`agentrun-dsl-source/${path}\n`), path);
    assert.equal(receipt.files.find(file => file.path === path)?.kind, 'text', path);
  }
  const secret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write(models[1], `CONSTANT Token = "${secret}"\n`);
  await assert.rejects(f.run(), /Source export blocked/);
  const blocked = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(blocked.findings.some(finding => finding.path === models[1]));
  await f.write(models[1], 'SPECIFICATION Spec\n');
  await f.write('spec/model/Model.toolbox', 'fixture\n');
  await assert.rejects(f.run(), /Unreviewed source-export file type: spec\/model\/Model\.toolbox/);
});

test('a recorded event stream (.sse) is archived and scanned as text: a machine path planted in one stops the export', async t => {
  const f = await fixture(t);
  const path = 'packages/x/test/fixtures/answer.sse';
  await f.write(path, 'event: message_start\ndata: {"type":"message_start"}\n\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok((await f.listing()).includes(`agentrun-dsl-source/${path}\n`));
  assert.equal(receipt.files.find(file => file.path === path)?.kind, 'text');
  const machinePath = ['', 'home', 'someone', 'secret.txt'].join('/');
  await f.write(path, `event: message_start\ndata: {"path":"${machinePath}"}\n\n`);
  await assert.rejects(f.run(), /Source export blocked/);
  const blocked = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(blocked.findings.some(finding => finding.path === path));
});

test('a SQL migration (.sql) is archived and scanned as text: a machine path planted in one stops the export', async t => {
  const f = await fixture(t);
  const path = 'packages/x/src/store/postgres/migrations/0001_initial.sql';
  await f.write(path, '-- the schema\nCREATE TABLE runs (id TEXT PRIMARY KEY);\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok((await f.listing()).includes(`agentrun-dsl-source/${path}\n`));
  assert.equal(receipt.files.find(file => file.path === path)?.kind, 'text');
  const machinePath = ['', 'home', 'someone', 'dump.sql'].join('/');
  await f.write(path, `-- restored from ${machinePath}\nCREATE TABLE runs (id TEXT PRIMARY KEY);\n`);
  await assert.rejects(f.run(), /Source export blocked/);
  const blocked = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(blocked.findings.some(finding => finding.path === path));
});

test('a /home/ or /Users/ right after a path parameter is an API route, not a machine path; a real one still stops the export', async t => {
  const f = await fixture(t);
  const route = 'packages/x/lib/routes.mjs';
  await f.write(route, 'export const path = "/agents/{agent_id}/home/files/{path}";\n');
  await f.run();
  const home = ['', 'home', 'someone', 'x'].join('/');
  const users = ['x ', 'Users', 'someone', 'y'].join('/');
  // A `}` that closes no route parameter does not excuse what follows: an interpolation, a bare brace, an encoded one.
  const interpolated = ['${root}', 'home', 'someone', '.config', ''].join('/');
  const braced = ['done {} }', 'Users', 'someone', 'x', ''].join('/');
  const encoded = ['%7D', 'home', 'someone', 'y', ''].join('%2F');
  for (const [path, text] of [['packages/x/lib/home.mjs', `"${home}"\n`], ['packages/x/lib/users.mjs', `"${users}"\n`], ['packages/x/lib/interpolated.mjs', `\`${interpolated}\`\n`], ['packages/x/lib/braced.mjs', `"${braced}"\n`], ['packages/x/lib/encoded.mjs', `"${encoded}"\n`]]) {
    await f.write(path, text);
    await assert.rejects(f.run(), /Source export blocked/);
    const blocked = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
    assert.deepEqual(blocked.findings.map(finding => [finding.path, finding.rule]), [[path, 'machine_path']]);
    await rm(join(f.root, path));
  }
});

test('/Users/Shared/ is macOS\'s folder shared by every user, not a machine path; any other /Users/ or /home/ name still stops the export', async t => {
  const f = await fixture(t);
  const shared = 'packages/x/lib/shared.mjs';
  await f.write(shared, `export const labels = "${['', 'Users', 'Shared', 'agentrun', 'labels.json'].join('/')}";\n`);
  await f.run();
  for (const [path, owner] of [['packages/x/lib/alice.mjs', ['', 'Users', 'alice', 'x'].join('/')], ['packages/x/lib/bob.mjs', ['', 'home', 'bob', 'x'].join('/')], ['packages/x/lib/shared-like.mjs', ['', 'Users', 'Sharedfolks', 'x'].join('/')]]) {
    await f.write(path, `"${owner}"\n`);
    await assert.rejects(f.run(), /Source export blocked/);
    const blocked = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
    assert.deepEqual(blocked.findings.map(finding => [finding.path, finding.rule]), [[path, 'machine_path']], owner);
    await rm(join(f.root, path));
  }
});

test('a PDF is archived only when one line of ASSETS.md names it with its SHA-256', async t => {
  const f = await fixture(t);
  const pdf = '%PDF-1.4\n% fixture\n%%EOF\n';
  await f.write('examples/demo/sample.pdf', pdf);
  await assert.rejects(f.run(), /Unreviewed PDF: examples\/demo\/sample\.pdf is not in ASSETS\.md with its SHA-256/);
  await f.write('ASSETS.md', `| \`sample.pdf\` | a fixture | \`${'0'.repeat(64)}\` |\n`);
  await assert.rejects(f.run(), /Unreviewed PDF/, 'its name with another hash is not its entry');
  const other = '%PDF-1.4\n% another fixture\n%%EOF\n';
  await f.write('ASSETS.md', `| \`sample.pdf\` | a fixture | \`${hash(other)}\` |\n| \`other.pdf\` | another | \`${hash(pdf)}\` |\n`);
  await assert.rejects(f.run(), /Unreviewed PDF/, 'its name on one line and its hash on another line is not its entry');
  await f.write('ASSETS.md', `| \`sample.pdf\` | a fixture | \`${hash(pdf)}\` |\n`);
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok((await f.listing()).includes('agentrun-dsl-source/examples/demo/sample.pdf\n'));
  assert.equal(receipt.files.find(file => file.path === 'examples/demo/sample.pdf')?.kind, 'binary');
});

test('the code owners file is archived and scanned as text; another extensionless .github file still stops the export', async t => {
  const f = await fixture(t);
  await f.write('.github/CODEOWNERS', '* @example-owner\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok((await f.listing()).includes('agentrun-dsl-source/.github/CODEOWNERS\n'));
  assert.equal(receipt.files.find(file => file.path === '.github/CODEOWNERS')?.kind, 'text');
  await f.write('.github/OWNERS', '* @example-owner\n');
  await assert.rejects(f.run(), /Unreviewed source-export file type: \.github\/OWNERS/);
});

test('the computer image recipe (the root helper, its Dockerfile and its two build scripts) is archived and scanned as text; another file there still stops the export', async t => {
  const f = await fixture(t);
  const box = ['packages/computer/box/agentrun-archil', 'packages/computer/box/Dockerfile', 'packages/computer/box/build-daytona.py', 'packages/computer/box/build-modal.py'];
  for (const path of box) await f.write(path, '# fixture\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  const listing = await f.listing();
  for (const path of box) {
    assert.ok(listing.includes(`agentrun-dsl-source/${path}\n`), path);
    assert.equal(receipt.files.find(file => file.path === path)?.kind, 'text', path);
  }
  // Any .py is text now (the Python client), so the file that must still stop the export has no reviewed type: no
  // extension and not one of the recipe's names.
  await f.write('packages/computer/box/agentrun-other', '# fixture\n');
  await assert.rejects(f.run(), /Unreviewed source-export file type: packages\/computer\/box\/agentrun-other/);
});

test('the media image recipe (packages/computer/media/Dockerfile) is archived and scanned as text; another file there still stops the export', async t => {
  const f = await fixture(t);
  await f.write('packages/computer/media/Dockerfile', '# fixture\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok((await f.listing()).includes('agentrun-dsl-source/packages/computer/media/Dockerfile\n'));
  assert.equal(receipt.files.find(file => file.path === 'packages/computer/media/Dockerfile')?.kind, 'text');
  await f.write('packages/computer/media/Containerfile', '# fixture\n');
  await assert.rejects(f.run(), /Unreviewed source-export file type: packages\/computer\/media\/Containerfile/);
});

test('the documents image recipe (packages/computer/documents: its Dockerfile and documents.sh) is archived and scanned as text', async t => {
  const f = await fixture(t);
  await f.write('packages/computer/documents/Dockerfile', '# fixture\n');
  await f.write('packages/computer/documents/documents.sh', '#!/bin/sh\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  for (const path of ['packages/computer/documents/Dockerfile', 'packages/computer/documents/documents.sh']) {
    assert.ok((await f.listing()).includes(`agentrun-dsl-source/${path}\n`), path);
    assert.equal(receipt.files.find(file => file.path === path)?.kind, 'text', path);
  }
});

test('inventory generation works without build output and does not produce an archive', async t => {
  const f = await fixture(t);
  await f.run('--inventory-only');
  const inventory = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  assert.match(inventory, /@parcha\/agentrun/);
  assert.doesNotMatch(inventory, /@agentrun\//);
  await assert.rejects(access(join(f.root, '.release/agentrun-dsl-source.tar.gz')));
  await assert.rejects(access(join(f.root, '.release/source-export-receipt.json')));
});

test('the dependency inventory follows the runtime graph only: a lock that changes a dev-only entry gives the same bytes, a runtime dependency changes them', async t => {
  const f = await fixture(t);
  const lock = ({ dev, runtime } = {}) => ({
    importers: { '.': dev ? { devDependencies: { 'dev-tool': dev } } : {}, ...(runtime ? { 'packages/dsl': { dependencies: { 'runtime-lib': runtime } } } : {}) },
    packages: { ...(runtime ? { [`runtime-lib@${runtime}`]: { license: 'MIT' } } : {}), ...(dev ? { [`dev-tool@${dev}`]: {} } : {}) },
  });
  const inventory = async spec => {
    await f.dependencies(spec);
    await f.run('--inventory-only');
    return readFile(join(f.root, 'docs/dependencies.md'));
  };
  const first = await inventory(lock({ dev: '1.0.0' }));
  // Any two pull requests that touch the lock would otherwise conflict on the doc while the lock itself merges clean.
  assert.deepEqual(await inventory(lock({ dev: '1.1.0' })), first, 'a dev-only change to the lock leaves the inventory byte for byte');
  const withRuntime = await inventory(lock({ dev: '1.0.0', runtime: '2.0.0' }));
  assert.notDeepEqual(withRuntime, first, 'a runtime dependency changes the inventory');
  assert.match(withRuntime.toString('utf8'), /runtime-lib/);
});

// pnpm's lockfile keeps no license: a runtime package whose declared license is not recorded stops the inventory, so a
// dependency change cannot list a package as UNKNOWN unnoticed.
test('a runtime package with no recorded license stops the inventory and names the command that records it', async t => {
  const f = await fixture(t);
  await f.dependencies({ importers: { 'packages/dsl': { dependencies: { 'new-lib': '1.0.0' } } }, packages: { 'new-lib@1.0.0': {} } });
  await assert.rejects(f.run('--inventory-only'), error => /No declared license recorded for new-lib@1\.0\.0: run node scripts\/export-source\.mjs --licenses/.test(error.stderr));
});

test('the ACP harness package is an inventory root: its runtime dependency ships in the source archive and is listed for it', async t => {
  const f = await fixture(t);
  await f.dependencies({ importers: { 'packages/run-adapters-acp': { dependencies: { 'acp-sdk': '2.7.0' } } }, packages: { 'acp-sdk@2.7.0': { license: 'Apache-2.0' } } });
  await f.run('--inventory-only');
  const inventory = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  assert.match(inventory, /\| acp-sdk \| 2\.7\.0 \| Apache-2\.0 \| run-adapters-acp \| no \| 1 \|/);
});

// OpenCode's per-platform binary packages publish no `license` field; their source, anomalyco/opencode at the pinned
// release, is MIT, as `opencode-ai` itself declares. The inventory reads them as MIT by name AND version: a bumped
// version is read as its manifest says again (UNKNOWN until it is checked), never carried over.
test('the inventory reads the pinned OpenCode binaries as MIT, flags nothing for them, and reads a bumped one as its manifest says', async t => {
  const f = await fixture(t);
  const inventory = async version => {
    await f.dependencies({ importers: { 'packages/serve': { optionalDependencies: { 'opencode-linux-x64': version } } }, packages: { [`opencode-linux-x64@${version}`]: { optional: true, license: null } } });
    await f.run('--inventory-only');
    return readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  };
  const pinned = await inventory('1.19.5');
  assert.deepEqual(
    [/\| opencode-linux-x64 \| 1\.19\.5 \| MIT \|/.test(pinned), /opencode-linux-x64@1\.19\.5:\*\* UNKNOWN/.test(pinned)],
    [true, false],
    'the pinned binary reads MIT and is not flagged',
  );
  const bumped = await inventory('1.19.6');
  assert.match(bumped, /opencode-linux-x64@1\.19\.6:\*\* UNKNOWN — Missing license metadata/, 'a bumped binary is read as its manifest says, and flagged until checked');
});

// An auth library names a test runner as an optional peer; the lock records the runner because the repository develops with it,
// and the runner pulls a bundler whose CSS engine is MPL-2.0. No consumer of the library installs any of them. A workspace
// package names the host it runs in as an optional peer, which the inventory keeps.
const optionalPeerLock = ({ requiredBy } = {}) => ({
  importers: {
    '.': { devDependencies: { 'test-runner': '1.0.0', 'host-agent': '1.0.0' } },
    'packages/serve': { dependencies: { 'auth-lib': '1.0.0' } },
    'packages/pi-browser': { peerDependencies: { 'host-agent': '*', 'absent-host': '*' }, peerDependenciesMeta: { 'host-agent': { optional: true }, 'absent-host': { optional: true } } },
    ...(requiredBy ? { [`packages/${requiredBy}`]: { dependencies: { 'test-runner': '1.0.0' } } } : {}),
  },
  packages: {
    'host-agent@1.0.0': { license: 'MIT' },
    'auth-lib@1.0.0': { license: 'MIT', peerDependencies: { 'test-runner': '*', 'absent-peer': '*' }, peerDependenciesMeta: { 'test-runner': { optional: true }, 'absent-peer': { optional: true } } },
    'test-runner@1.0.0': { license: 'MIT', dependencies: { bundler: '1.0.0' } },
    'bundler@1.0.0': { license: 'MIT', dependencies: { 'css-engine': '1.0.0' } },
    'css-engine@1.0.0': { license: 'MPL-2.0' },
  },
});

test('the dependency inventory leaves out an optional peer nothing requires at runtime, and everything under it', async t => {
  const f = await fixture(t);
  await f.dependencies(optionalPeerLock());
  await f.run('--inventory-only');
  const inventory = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  assert.match(inventory, /\| auth-lib \| 1\.0\.0 \| MIT \| serve \| no \| 1 \|/);
  for (const name of ['test-runner', 'bundler', 'css-engine']) assert.doesNotMatch(inventory, new RegExp(`\\| ${name} \\|`), `${name} is not shipped`);
  assert.match(inventory, /\| host-agent \| 1\.0\.0 \| MIT \| pi-browser \| no \| 1 \|/, 'a workspace package\'s own optional peer is followed');
  assert.match(inventory, /No missing, restrictive, reciprocal, or unrecognized license identifiers/);
  assert.match(inventory, /Optional peer\/dependency names absent from this lockfile: [^\n]*`absent-host`/, 'a workspace package\'s optional peer the lock does not record is named, not an error');
  assert.match(inventory, /Optional peer\/dependency names absent from this lockfile: [^\n]*`absent-peer`/, 'an optional peer the lock does not record is still named');
});

test('the dependency inventory keeps an optional peer that a runtime dependency requires, for the package that requires it', async t => {
  const f = await fixture(t);
  await f.dependencies(optionalPeerLock({ requiredBy: 'jev' }));
  await f.run('--inventory-only');
  const inventory = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  for (const name of ['test-runner', 'bundler', 'css-engine']) assert.match(inventory, new RegExp(`\\| ${name} \\| 1\\.0\\.0 \\| [^|]+ \\| jev \\| no \\| 1 \\|`), `${name} ships with jev`);
  assert.match(inventory, /\*\*css-engine@1\.0\.0:\*\* MPL-2\.0 — License expression needs release-owner review\./);
});

test('a run-state directory under a package is never exported, and a long one-line journal does not stall the scan', async t => {
  const f = await fixture(t);
  await f.write('examples/public.mjs', 'export const value = 42;\n');
  // A journal as a long run writes it: one line, megabytes of host-like tokens.
  const journal = JSON.stringify({ state: { text: 'ab.cd.'.repeat(400_000) } });
  await f.write('packages/dsl/.pi/agentrun/runs/run-1/journal.json', journal);
  await f.write('.pi/agentrun/runs/run-2/journal.json', journal);
  const started = Date.now();
  await exec(process.execPath, [join(f.root, 'scripts/export-source.mjs')], { cwd: f.root, timeout: 30_000 });
  assert.ok(Date.now() - started < 30_000);
  const listing = await f.listing();
  assert.match(listing, /agentrun-dsl-source\/examples\/public\.mjs/);
  assert.doesNotMatch(listing, /\.pi\//);
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(!receipt.files.some(file => file.path.split('/').includes('.pi')));
});

test('the scan stays linear on a long line of host characters and still finds an internal domain', async t => {
  const f = await fixture(t);
  await f.write('docs/long.md', `${'ab.cd.'.repeat(400_000)}\n`);
  const started = Date.now();
  await f.run();
  assert.ok(Date.now() - started < 30_000, 'a long line of dotted tokens must scan in linear time');
  await f.write('docs/host.md', `see build-box.example.${'ts'}.net for the box\n`);
  await assert.rejects(f.run(), error => /unreviewed finding/.test(error.stderr));
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.ok(receipt.findings.some(finding => finding.path === 'docs/host.md' && finding.rule === 'internal_domain'));
});

test('a Northflank docs URL in the provider scorecard is a reviewed citation; the domain anywhere else still blocks', async t => {
  const f = await fixture(t);
  // Built from parts so this file carries none of the internal domains it tests.
  const northflank = ['northflank', 'com'].join('.');
  const scorecard = 'packages/computer/SCORECARD.md';
  await f.write(scorecard, `exec ([execute command](https://${northflank}/docs/v1/api/execute-command.md)), sandboxes ([cloud](https://${northflank}/docs/v1/application/sandboxes))\n`);
  await f.run();
  const passed = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.deepEqual(passed.findings, []);
  assert.deepEqual(passed.reviewedFindings.map(finding => [finding.path, finding.rule, finding.reason]), [[scorecard, 'internal_domain', 'public vendor documentation citation']]);
  const blocking = [
    [scorecard, `pricing: https://${northflank}/pricing\n`],
    [scorecard, `an app URL: https://app.${northflank}/docs/v1/api\n`],
    [scorecard, `[docs](https://${northflank}/docs/v1/api) and the console at ${northflank}\n`],
    [scorecard, `a service at build-box.${['code', 'run'].join('.')}\n`],
    [scorecard, `a box at build-box.example.${['ts', 'net'].join('.')}\n`],
    ['packages/computer/PROVIDERS.md', `see https://${northflank}/docs/v1/api/execute-command.md\n`],
    ['docs/vendors.md', `see https://${northflank}/docs/v1/application/sandboxes\n`],
  ];
  for (const [path, text] of blocking) {
    await f.write(scorecard, '# Provider scorecard\n');
    await f.write(path, text);
    await assert.rejects(f.run(), /Source export blocked/, text);
    const blocked = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
    assert.deepEqual(blocked.findings.map(finding => [finding.path, finding.rule]), [[path, 'internal_domain']], text);
    await rm(join(f.root, path));
  }
});

test('vendored code an app keeps is listed apart, with its source, licenses and size, and a license the inventory does not take is flagged', async t => {
  const f = await fixture(t);
  const manifest = (license) => JSON.stringify({ name: 'some-lib', version: '1.2.3', license: 'MIT', source: 'https://registry.example.org/some-lib-1.2.3.tgz',
    files: [{ path: 'lib.min.mjs', from: 'build/lib.min.mjs', license, bytes: 10, sha256: '0'.repeat(64) }, { path: 'LICENSE.txt', from: 'LICENSE', license: 'MIT', bytes: 5, sha256: '1'.repeat(64) }] });
  await f.run('--inventory-only');
  const without = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  assert.doesNotMatch(without, /Vendored code/, 'no section when no app vendors code');
  await f.write('apps/viewer/vendor/some-lib/vendored.json', manifest('MIT AND BSD-3-Clause'));
  await f.run('--inventory-only');
  const inventory = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  assert.match(inventory, /## Vendored code/);
  assert.match(inventory, /\| some-lib \| 1\.2\.3 \| BSD-3-Clause, MIT \| apps\/viewer\/vendor\/some-lib \| https:\/\/registry\.example\.org\/some-lib-1\.2\.3\.tgz \| 15 \|/);
  assert.match(inventory, /No missing, restrictive, reciprocal, or unrecognized license identifiers/);
  await f.write('apps/viewer/vendor/some-lib/vendored.json', manifest('GPL-3.0-only'));
  await f.run('--inventory-only');
  assert.match(await readFile(join(f.root, 'docs/dependencies.md'), 'utf8'), /\*\*some-lib@1\.2\.3:\*\* GPL-3\.0-only — Restrictive or reciprocal metadata needs release-owner review\./);
});

test('a .patch file stops the export: none is reviewed (the durable-harness port froze, its patches gone)', async t => {
  const f = await fixture(t);
  await f.write('packages/run-adapters/vendor/durable-harness/port/patches/harness-process/001-begin-reservation.patch', 'Patch: 001-begin-reservation\n');
  await assert.rejects(f.run(), /Unreviewed source-export file type: packages\/run-adapters\/vendor\/durable-harness\/port\/patches\/harness-process\/001-begin-reservation\.patch/);
});

test('a TSX source file is archived and scanned like any other source', async t => {
  const f = await fixture(t);
  // apps/console is React in TSX: a .tsx file is source text, so it is exported and its contents are scanned for secrets.
  await f.write('apps/console/src/App.tsx', 'export const App = () => <main>AgentRun</main>;\n');
  await f.run();
  assert.match(await f.listing(), /agentrun-dsl-source\/apps\/console\/src\/App\.tsx/);
  const fakeSecret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write('apps/console/src/Key.tsx', `export const key = "${fakeSecret}";\n`);
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /Source export blocked/);
    return true;
  });
});

test('the Python client is source: its .py files, pyproject.toml and py.typed are archived and scanned; its bytecode is left out', async t => {
  const f = await fixture(t);
  const sources = ['python/pyproject.toml', 'python/README.md', 'python/LICENSE', 'python/NOTICE', 'python/agentrun/__init__.py', 'python/agentrun/py.typed', 'python/tests/test_rules.py'];
  for (const path of sources) await f.write(path, `# ${path}\n`);
  await f.write('python/agentrun/__pycache__/_client.cpython-311.pyc', 'BYTECODE\n');
  await f.write('python/tests/__pycache__/helpers.cpython-311.pyc', 'BYTECODE\n');
  // What `pip install ./python` leaves beside the source: its build tree and its metadata.
  await f.write('python/build/lib/agentrun/__init__.py', '# a copy\n');
  await f.write('python/parcha_agentrun.egg-info/PKG-INFO', 'Metadata-Version: 2.1\n');
  await f.run();
  const listing = await f.listing();
  for (const path of sources) assert.match(listing, new RegExp(`agentrun-dsl-source/${path.replace(/\./g, '\\.')}\\n`), path);
  assert.doesNotMatch(listing, /__pycache__|\.pyc|python\/build\/|egg-info/);
  const fakeSecret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write('python/agentrun/_key.py', `KEY = "${fakeSecret}"\n`);
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /Source export blocked/);
    return true;
  });
  await f.write('python/agentrun/_key.py', 'KEY = None\n');
  await f.write('python/agentrun/native.so', 'ELF\n');
  await assert.rejects(f.run(), /Unreviewed source-export file type: python\/agentrun\/native\.so/);
});
