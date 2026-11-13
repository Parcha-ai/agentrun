#!/usr/bin/env node
// The Python client's release, parcha-agentrun (python/), published to PyPI after the npm packages. It has a version line of its
// own, as @parcha/agentrun has (docs/releasing.md): a plain x.y.z above 0.2.1, the old hosted SDK PyPI already holds under the
// same name. pip installs the highest final release, so a pre-release (0.3.0b1) would leave `pip install parcha-agentrun` on
// 0.2.1: the line has none. The release builds the sdist and wheel with `python -m build`, and this script checks them before
// anything is uploaded:
//   node scripts/python-release.mjs --verify DIST [--python PYTHON]
//       the project (its name, version, classifiers, LICENSE and NOTICE), DIST's sdist and wheel against this tree's python/,
//       file for file, `twine check --strict`, and the wheel installed in a clean venv whose smoke runs with no network;
//       writes .release/python-plan.json, the files' SHA-256, as evidence: the release job retains it with the archives it uploads
//   node scripts/python-release.mjs --on-pypi DIST [--python PYTHON]
//       whether this version is on PyPI already: publish=true on PyPI's 404; publish=false when its wheel there carries DIST's
//       wheel's agentrun/ files byte for byte (a re-run publishes nothing twice); a version there with other contents, any
//       other answer and any network failure stop the release. Written to $GITHUB_OUTPUT when it is set
// PYTHON (default python3) needs twine for --verify. The script uploads nothing: the release workflow's trusted-publishing step does.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { pythonVersionOf } from './changes.mjs';
import { isMain } from './is-main.mjs';

const exec = promisify(execFile);
export const PYTHON_NAME = 'parcha-agentrun';
/** The highest version PyPI holds from the old hosted SDK: the client's line is above it. */
export const PYPI_FLOOR = '0.2.1';
const DO_NOT_UPLOAD = 'Private :: Do Not Upload';
// A canonical PEP 440 public release of three parts, with no pre-, post-, dev- or local segment.
const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Refuses a version off the client's line: not a canonical x.y.z, or not above PYPI_FLOOR. */
export function checkPythonVersion(version) {
  assert.ok(typeof version === 'string' && PLAIN.test(version), `parcha-agentrun's version ${JSON.stringify(version)} is not a PEP 440 x.y.z: its line, like @parcha/agentrun's, is plain releases, and pip passes over a pre-release, which would leave pip install on ${PYPI_FLOOR}`);
  const [given, floor] = [version, PYPI_FLOOR].map(text => text.split('.').map(Number));
  const above = given[0] !== floor[0] ? given[0] > floor[0] : given[1] !== floor[1] ? given[1] > floor[1] : given[2] > floor[2];
  assert.ok(above, `parcha-agentrun's version ${version} must be above ${PYPI_FLOOR}, the old hosted SDK PyPI already holds: pip installs the highest`);
}

/** The project the release publishes, checked: its name, its version line, no Do-Not-Upload classifier, the version its package
 *  says, and the root's LICENSE and NOTICE beside it (they go into the sdist and the wheel). */
export async function checkPythonProject(root) {
  const text = await readFile(join(root, 'python/pyproject.toml'), 'utf8');
  const name = /^\[project\][\s\S]*?^name\s*=\s*"([^"]*)"/m.exec(text)?.[1];
  assert.equal(name, PYTHON_NAME, `python/pyproject.toml names ${name}, not ${PYTHON_NAME}`);
  const version = pythonVersionOf(text);
  checkPythonVersion(version);
  assert.ok(!text.includes(DO_NOT_UPLOAD), `python/pyproject.toml still holds the classifier "${DO_NOT_UPLOAD}": PyPI refuses it, and it said the package was held`);
  const init = await readFile(join(root, 'python/agentrun/__init__.py'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const declared = /^__version__\s*=\s*"([^"]*)"/m.exec(init)?.[1];
  if (declared !== undefined) assert.equal(declared, version, `python/agentrun/__init__.py says __version__ ${declared}; python/pyproject.toml says ${version}`);
  for (const file of ['LICENSE', 'NOTICE']) {
    const rooted = await readFile(join(root, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (rooted === null) continue;
    const beside = await readFile(join(root, 'python', file), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.equal(beside, rooted, `python/${file} is not the root ${file}: the sdist and the wheel carry it`);
  }
  return { name, version };
}

/** Every file under `directory`, by its path relative to `base`, with its SHA-256; bytecode left out. */
async function treeFiles(directory, base) {
  const found = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    if (entry.isDirectory()) for (const [name, hash] of await treeFiles(path, base)) found.set(name, hash);
    else if (entry.isFile()) found.set(relative(base, path).split('\\').join('/'), sha256(await readFile(path)));
  }
  return found;
}

/** An sdist's or a wheel's members, by name, with their SHA-256, read with Python's own tarfile and zipfile. */
async function archiveMembers(file, python) {
  const script = `
import hashlib, json, sys, tarfile, zipfile
path = sys.argv[1]
members = {}
if path.endswith(".whl"):
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if not info.is_dir(): members[info.filename] = hashlib.sha256(archive.read(info)).hexdigest()
else:
    with tarfile.open(path, "r:gz") as archive:
        for info in archive.getmembers():
            if info.isfile(): members[info.name] = hashlib.sha256(archive.extractfile(info).read()).hexdigest()
print(json.dumps(members))
`;
  return new Map(Object.entries(JSON.parse((await exec(python, ['-I', '-c', script, file], { maxBuffer: 64 * 1024 * 1024 })).stdout)));
}

/** DIST's sdist and wheel, checked to be this tree's python/ at its version: exactly the two files the version names, each
 *  carrying every file of python/agentrun byte for byte and no other, the sdist its project, README, LICENSE and NOTICE too.
 *  Returns the plan: the version and each file's SHA-256. */
export async function checkPythonDist(root, dist, python = 'python3') {
  const { name, version } = await checkPythonProject(root);
  const base = `parcha_agentrun-${version}`;
  const sdist = `${base}.tar.gz`;
  const wheel = `${base}-py3-none-any.whl`;
  const present = (await readdir(dist, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort();
  assert.deepEqual(present, [wheel, sdist].sort(), `${dist}: expected exactly ${sdist} and ${wheel}, this tree's version; found ${present.join(', ') || 'nothing'}`);
  const tree = await treeFiles(join(root, 'python/agentrun'), join(root, 'python'));
  const project = new Map(await Promise.all(['pyproject.toml', 'README.md', 'LICENSE', 'NOTICE'].map(async file => [file, sha256(await readFile(join(root, 'python', file)).catch(() => Buffer.from('')))])));
  const same = (file, members, at, expected) => {
    for (const [path, hash] of expected) {
      assert.ok(members.has(`${at}${path}`), `${file} is missing ${path}`);
      assert.equal(members.get(`${at}${path}`), hash, `${file}: ${path} is not this tree's python/${path}`);
    }
    for (const member of members.keys()) {
      const path = member.slice(at.length);
      if (member.startsWith(`${at}agentrun/`)) assert.ok(tree.has(path), `${file} holds ${path}, which this tree's python/agentrun does not`);
    }
  };
  const members = await archiveMembers(join(dist, wheel), python);
  same(wheel, members, '', tree);
  // The licence files setuptools 77 and newer package (PEP 639): the root's LICENSE and NOTICE, byte for byte.
  for (const file of ['LICENSE', 'NOTICE']) {
    const rooted = await readFile(join(root, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (rooted === null) continue;
    const at = `${base}.dist-info/licenses/${file}`;
    assert.ok(members.has(at), `${wheel} is missing ${at}`);
    assert.equal(members.get(at), sha256(rooted), `${wheel}: ${at} is not the root ${file}`);
  }
  same(sdist, await archiveMembers(join(dist, sdist), python), `${base}/`, new Map([...tree, ...project]));
  const files = [];
  for (const filename of [wheel, sdist].sort()) files.push({ filename, sha256: sha256(await readFile(join(dist, filename))) });
  return { name, version, files };
}

/** `twine check --strict` on DIST's files, then the wheel installed with no index into a clean venv, whose smoke imports the
 *  installed package (not this tree's), constructs a client and has a usage error refused, all with every connection refused. */
async function verifyInstall(dist, plan, python) {
  const paths = plan.files.map(file => join(dist, file.filename));
  console.log((await exec(python, ['-m', 'twine', 'check', '--strict', ...paths])).stdout.trim());
  const venv = await mkdtemp(join(tmpdir(), 'parcha-agentrun-venv-'));
  try {
    await exec(python, ['-m', 'venv', venv]);
    const bin = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
    const wheel = paths.find(path => path.endsWith('.whl'));
    await exec(bin, ['-m', 'pip', 'install', '--no-index', '--no-deps', '--disable-pip-version-check', '--quiet', wheel]);
    const smoke = `
import json, socket, sys
def refused(*args, **kwargs):
    raise AssertionError("the smoke tried the network")
socket.socket.connect = refused
socket.create_connection = refused
socket.getaddrinfo = refused
import importlib.metadata, agentrun
version = sys.argv[1]
assert importlib.metadata.version("parcha-agentrun") == version
assert agentrun.__version__ == version, agentrun.__version__
assert "site-packages" in agentrun.__file__, agentrun.__file__
client = agentrun.AgentRun(base_url="https://agentrun.example.com/v2", api_key="test-key")
try:
    client.runs.get("..")
except agentrun.AgentRunUsage as error:
    usage = error.kind
else:
    raise AssertionError("a .. path argument was not refused")
assert "test-key" not in repr(client)
print(json.dumps({"installed": version, "client": True, "usage": usage, "network": "refused"}))
`;
    return JSON.parse((await exec(bin, ['-I', '-c', smoke, plan.version], { cwd: venv })).stdout.trim());
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
}

/** Whether this version is on PyPI, and if so whether it is this tree's: 'absent' on PyPI's 404, 'same' when the wheel it
 *  holds carries the freshly built wheel's agentrun/ files byte for byte. A version on PyPI with other contents throws: a
 *  change merged without a version bump would otherwise be skipped, and pip would never get it. The published wheel is
 *  fetched over https only, and its SHA-256 checked against the digest PyPI's JSON API gives. Any other answer, and any
 *  network failure, throws: nothing here is ever read as a skip. */
export async function publishedState(version, builtWheel, python = 'python3', fetchImpl = fetch) {
  const response = await fetchImpl(`https://pypi.org/pypi/${PYTHON_NAME}/${version}/json`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return 'absent';
  assert.equal(response.status, 200, `PyPI answered ${response.status} for ${PYTHON_NAME} ${version}: not published, not skipped`);
  const wheelName = basename(builtWheel);
  const entry = ((await response.json())?.urls ?? []).find(file => file?.packagetype === 'bdist_wheel' && file?.filename === wheelName);
  assert.ok(entry, `${PYTHON_NAME} ${version} is on PyPI with no ${wheelName} to compare: bump python/pyproject.toml's version`);
  assert.ok(typeof entry.url === 'string' && entry.url.startsWith('https://'), `PyPI names ${wheelName} at a URL that is not https: not fetched`);
  const digest = entry.digests?.sha256;
  assert.ok(typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest), `PyPI gives no SHA-256 for ${wheelName}: not compared, not skipped`);
  const download = await fetchImpl(entry.url, { signal: AbortSignal.timeout(120_000) });
  assert.equal(download.status, 200, `PyPI's ${wheelName} answered ${download.status}: not compared, not skipped`);
  assert.ok(!download.url || download.url.startsWith('https://'), `PyPI's ${wheelName} came from a URL that is not https: not compared`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(sha256(bytes), digest, `PyPI's ${wheelName} is not the file its digest names: not compared, not skipped`);
  const folder = await mkdtemp(join(tmpdir(), 'parcha-agentrun-published-'));
  try {
    await writeFile(join(folder, wheelName), bytes);
    const package_ = (members) => [...members].filter(([name]) => name.startsWith('agentrun/')).sort(([a], [b]) => a.localeCompare(b));
    const published = package_(await archiveMembers(join(folder, wheelName), python));
    const built = package_(await archiveMembers(builtWheel, python));
    assert.deepEqual(published, built, `${PYTHON_NAME} ${version} is on PyPI with different contents: bump python/pyproject.toml's version`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return 'same';
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({ options: { verify: { type: 'string' }, python: { type: 'string' }, 'on-pypi': { type: 'string' } } });
  const python = values.python ?? 'python3';
  if (values.verify) {
    const dist = resolve(values.verify);
    const plan = await checkPythonDist(root, dist, python);
    console.log(`${plan.name} ${plan.version}: the sdist and wheel are this tree's python/, file for file`);
    const smoke = await verifyInstall(dist, plan, python);
    console.log(`Clean venv: ${JSON.stringify(smoke)}`);
    await mkdir(join(root, '.release'), { recursive: true });
    await writeFile(join(root, '.release/python-plan.json'), `${JSON.stringify({ ...plan, smoke }, null, 2)}\n`);
    for (const file of plan.files) console.log(`${file.sha256}  ${file.filename}`);
    console.log('Python release checks passed. Plan: .release/python-plan.json. Nothing was uploaded.');
  } else if (values['on-pypi']) {
    const dist = resolve(values['on-pypi']);
    const { version } = await checkPythonProject(root);
    const state = await publishedState(version, join(dist, `parcha_agentrun-${version}-py3-none-any.whl`), python);
    console.log(state === 'same' ? `${PYTHON_NAME} ${version} is on PyPI already, with this tree's agentrun/: it is not published again.` : `${PYTHON_NAME} ${version} is not on PyPI: the release publishes it.`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${state === 'same' ? 'false' : 'true'}\n`);
  } else {
    throw new Error('Usage: node scripts/python-release.mjs --verify DIST [--python PYTHON] | --on-pypi DIST [--python PYTHON]');
  }
}

if (isMain(import.meta)) await main();
