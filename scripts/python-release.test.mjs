// The Python client's release checks (scripts/python-release.mjs): parcha-agentrun is on a version line of its own, a plain x.y.z
// above the 0.2.1 PyPI already holds (the old hosted SDK), with no Do-Not-Upload classifier and the root's LICENSE and NOTICE; and
// the sdist and wheel the release uploads are this tree's python/, file for file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPythonDist, checkPythonProject, checkPythonVersion, PYPI_FLOOR } from './python-release.mjs';

const python = spawnSync('python3', ['--version']).status === 0;
const LICENSE = 'Apache License\nVersion 2.0, January 2004\n';
const NOTICE = 'AgentRun\nCopyright Parcha Labs, Inc.\n';
const pyproject = ({ version = '0.3.0', classifiers = ['Typing :: Typed'] } = {}) => `[project]
name = "parcha-agentrun"
version = "${version}"
license = "Apache-2.0"
classifiers = [
${classifiers.map((classifier) => `    "${classifier}",`).join('\n')}
]
`;

async function tree(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'python-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, text) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await write('LICENSE', LICENSE);
  await write('NOTICE', NOTICE);
  await write('python/LICENSE', LICENSE);
  await write('python/NOTICE', NOTICE);
  await write('python/README.md', '# parcha-agentrun\n');
  await write('python/pyproject.toml', pyproject(options));
  await write('python/agentrun/__init__.py', 'from ._client import AgentRun\n');
  await write('python/agentrun/_client.py', 'class AgentRun: ...\n');
  await write('python/agentrun/py.typed', '');
  await write('python/tests/test_rules.py', 'import unittest\n');
  return { root, write };
}

/** An sdist and a wheel of `root`'s python/ as setuptools lays them out, written with python3's own tarfile and zipfile;
 *  `edit` changes a member's text on its way into both. */
function distOf(root, version, dist, edit = {}) {
  const script = `
import io, json, os, sys, tarfile, zipfile
root, version, dist, edit = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
src = os.path.join(root, "python")
files = ["pyproject.toml", "README.md", "LICENSE", "NOTICE"] + ["agentrun/" + name for name in sorted(os.listdir(os.path.join(src, "agentrun")))]
def data(name):
    if name in edit: return edit[name].encode()
    with open(os.path.join(src, name), "rb") as handle: return handle.read()
os.makedirs(dist, exist_ok=True)
base = f"parcha_agentrun-{version}"
with tarfile.open(os.path.join(dist, base + ".tar.gz"), "w:gz") as tar:
    for name in files + ["PKG-INFO"]:
        body = b"Metadata-Version: 2.4\\n" if name == "PKG-INFO" else data(name)
        info = tarfile.TarInfo(f"{base}/{name}"); info.size = len(body); tar.addfile(info, io.BytesIO(body))
with zipfile.ZipFile(os.path.join(dist, base + "-py3-none-any.whl"), "w") as wheel:
    for name in files:
        if name.startswith("agentrun/"): wheel.writestr(name, data(name))
    wheel.writestr(f"{base}.dist-info/METADATA", "Metadata-Version: 2.4\\n")
    wheel.writestr(f"{base}.dist-info/licenses/LICENSE", data("LICENSE"))
    wheel.writestr(f"{base}.dist-info/licenses/NOTICE", data("NOTICE"))
`;
  const made = spawnSync('python3', ['-I', '-c', script, root, version, dist, JSON.stringify(edit)], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
}

test(`the version is parcha-agentrun's own line: a canonical PEP 440 x.y.z above ${PYPI_FLOOR}, never a pre-release pip would pass over`, () => {
  for (const version of ['0.3.0', '0.2.2', '1.0.0', '0.10.0']) assert.doesNotThrow(() => checkPythonVersion(version), version);
  for (const version of ['0.3', 'v0.3.0', '0.3.0-beta.1', '0.3.00', 'banana', '']) assert.throws(() => checkPythonVersion(version), /not a PEP 440 x\.y\.z/, version);
  // pip installs the highest final release unless asked for --pre: a pre-release would leave `pip install parcha-agentrun` on 0.2.1.
  for (const version of ['0.3.0b1', '0.3.0rc1', '0.3.0.dev1', '0.3.0a0']) assert.throws(() => checkPythonVersion(version), /not a PEP 440 x\.y\.z/, version);
  for (const version of ['0.2.1', '0.2.0', '0.1.9', '0.0.1']) assert.throws(() => checkPythonVersion(version), /must be above 0\.2\.1/, version);
});

test('the project is the one to publish: its name, its own version line, no Do-Not-Upload classifier, and the root LICENSE and NOTICE', async (t) => {
  const ok = await tree(t);
  assert.deepEqual(await checkPythonProject(ok.root), { name: 'parcha-agentrun', version: '0.3.0' });
  const held = await tree(t, { classifiers: ['Typing :: Typed', 'Private :: Do Not Upload'] });
  await assert.rejects(checkPythonProject(held.root), /Private :: Do Not Upload/);
  const old = await tree(t, { version: '0.2.1' });
  await assert.rejects(checkPythonProject(old.root), /must be above 0\.2\.1/);
  const beta = await tree(t, { version: '0.3.0b1' });
  await assert.rejects(checkPythonProject(beta.root), /not a PEP 440 x\.y\.z/);
  await ok.write('python/agentrun/__init__.py', '__version__ = "0.2.9"\n');
  await assert.rejects(checkPythonProject(ok.root), /__init__\.py says __version__ 0\.2\.9; python\/pyproject\.toml says 0\.3\.0/);
  await ok.write('python/agentrun/__init__.py', '__version__ = "0.3.0"\n');
  assert.deepEqual(await checkPythonProject(ok.root), { name: 'parcha-agentrun', version: '0.3.0' });
  await ok.write('python/LICENSE', 'MIT\n');
  await assert.rejects(checkPythonProject(ok.root), /python\/LICENSE is not the root LICENSE/);
});

test('the sdist and wheel are this tree\'s python/, file for file and by their version; their hashes are the plan', { skip: !python && 'no python3 to write the archives with' }, async (t) => {
  const { root } = await tree(t);
  const dist = join(root, 'dist');
  distOf(root, '0.3.0', dist);
  const plan = await checkPythonDist(root, dist);
  assert.deepEqual(plan.files.map((file) => file.filename), ['parcha_agentrun-0.3.0-py3-none-any.whl', 'parcha_agentrun-0.3.0.tar.gz']);
  assert.ok(plan.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.equal(plan.version, '0.3.0');

  const edited = join(root, 'edited');
  distOf(root, '0.3.0', edited, { 'agentrun/_client.py': 'class AgentRun: pass  # edited\n' });
  await assert.rejects(checkPythonDist(root, edited), /parcha_agentrun-0\.3\.0-py3-none-any\.whl: agentrun\/_client\.py is not this tree's python\/agentrun\/_client\.py/);

  const stale = join(root, 'stale');
  distOf(root, '0.2.9', stale);
  await assert.rejects(checkPythonDist(root, stale), /expected exactly parcha_agentrun-0\.3\.0\.tar\.gz and parcha_agentrun-0\.3\.0-py3-none-any\.whl/);

  const extra = join(root, 'extra');
  distOf(root, '0.3.0', extra);
  await writeFile(join(extra, 'parcha_agentrun-0.2.9.tar.gz'), 'old');
  await assert.rejects(checkPythonDist(root, extra), /expected exactly/);

  // A file the tree's package has that the wheel lost is a mismatch too.
  await writeFile(join(root, 'python/agentrun/_live.py'), 'LIVE = 1\n');
  await assert.rejects(checkPythonDist(root, dist), /is missing agentrun\/_live\.py/);
  assert.equal(await readFile(join(root, 'python/agentrun/_live.py'), 'utf8'), 'LIVE = 1\n');
});

test('release.yml publishes parcha-agentrun only after the npm packages, by trusted publishing, after its checks, and never twice', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.pypi;
  assert.equal(job.needs, 'publish', 'after the npm packages are published and verified');
  assert.equal(job.if, workflow.jobs.publish.if, 'where npm publishing runs, and nowhere else');
  assert.equal(job.environment, 'pypi-release');
  assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
  const uses = job.steps.filter((step) => step.uses).map((step) => step.uses);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned by commit: the job holds an OIDC token`);
  const text = JSON.stringify(job);
  assert.ok(!/secrets\.|password|token:/i.test(text.replace(/"id-token":"write"/, '')), 'no token or secret: trusted publishing only');
  const at = (pattern) => job.steps.findIndex((step) => pattern.test(step.run ?? step.uses ?? ''));
  const upload = at(/^pypa\/gh-action-pypi-publish@/);
  assert.ok(at(/python -m build /) < at(/python-release\.mjs --verify/) && at(/python-release\.mjs --verify/) < at(/python-release\.mjs --on-pypi/) && at(/--on-pypi/) < upload, 'build, then the checks, then the PyPI probe, then the upload');
  assert.equal(job.steps[upload].if, "steps.pypi.outputs.publish == 'true'", 'a version on PyPI already is not published again');
});
