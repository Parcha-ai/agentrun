// What `npm run build` wrote, built once per Node version in CI's build job and unpacked by the jobs that test it.
//   node scripts/ci-build-output.mjs pack <dir>     after the build: <dir>/build.tar and <dir>/build.json
//   node scripts/ci-build-output.mjs unpack <dir>   after `npm ci` in a test job: checks build.json, then extracts build.tar
// The output is every file git ignores that is not under a node_modules: each workspace's dist and the console's, and
// anything else a build starts to write, without a list to keep. node_modules is not in it: each job's `npm ci` restores
// 1.3 GB from npm's cache in about 10 s, faster than an artifact of that size moves.
// `unpack` refuses an output built from another tree or on another Node, or whose tar is not the one packed, and fails
// when the extraction changed a file git tracks or left one git neither tracks nor ignores: a build that wrote into the
// source would otherwise go unseen.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './is-main.mjs';

const git = (root, args) => {
  const done = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} exited ${done.status ?? done.signal}: ${done.stderr.trim()}`);
  return done.stdout;
};
const tar = (args) => {
  const done = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`tar ${args.join(' ')} exited ${done.status ?? done.signal}: ${done.stderr.trim()}`);
  return done.stdout;
};
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const tree = (root) => git(root, ['rev-parse', 'HEAD^{tree}']).trim();

/** The build's output under `root`: the ignored, untracked paths outside every node_modules, as git names them. */
export function outputPaths(root) {
  return git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
    .split('\0').filter(Boolean).filter((path) => !path.split('/').includes('node_modules')).sort();
}

/** What `git status` reports beyond a clean checkout, one line each. */
export function changes(root) {
  return git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);
}

export function pack(root, dir) {
  const dirty = changes(root);
  if (dirty.length) throw new Error(`the build changed or added files git does not ignore, so they would not reach the test jobs:\n${dirty.join('\n')}`);
  const paths = outputPaths(root);
  if (!paths.length) throw new Error('the build wrote nothing git ignores: run `npm run build` first');
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, 'build.tar');
  tar(['-cf', archive, '-C', root, '--', ...paths]);
  const files = tar(['-tf', archive]).split('\n').filter((line) => line && !line.endsWith('/')).length;
  const manifest = { tree: tree(root), node: process.version, paths, files, bytes: statSync(archive).size, sha256: sha256(archive) };
  writeFileSync(join(dir, 'build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function unpack(root, dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'));
  const archive = join(dir, 'build.tar');
  const problems = [];
  if (manifest.tree !== tree(root)) problems.push(`it was built from the tree ${manifest.tree}, and this checkout is ${tree(root)}`);
  if (manifest.node !== process.version) problems.push(`it was built on Node ${manifest.node}, and this job runs ${process.version}`);
  if (sha256(archive) !== manifest.sha256) problems.push('build.tar is not the archive the build job packed (its sha256 differs)');
  if (problems.length) throw new Error(`the build output does not belong to this job: ${problems.join('; ')}`);
  const before = changes(root);
  if (before.length) throw new Error(`the checkout is not clean before the build output is unpacked:\n${before.join('\n')}`);
  // -m: each file gets the time it is unpacked, so the output is newer than the checkout, as a local build's is.
  tar(['-x', '-m', '-f', archive, '-C', root]);
  const after = changes(root);
  if (after.length) throw new Error(`unpacking the build output changed files git does not ignore:\n${after.join('\n')}`);
  return manifest;
}

if (isMain(import.meta)) {
  const [command, dir] = process.argv.slice(2);
  const root = process.cwd();
  try {
    if (!dir || !['pack', 'unpack'].includes(command)) throw new Error('usage: node scripts/ci-build-output.mjs pack|unpack <dir>');
    const started = Date.now();
    const manifest = command === 'pack' ? pack(root, resolve(dir)) : unpack(root, resolve(dir));
    console.log(`${command === 'pack' ? 'packed' : 'unpacked'} ${manifest.files} files in ${manifest.paths.length} directories, ${(manifest.bytes / 1e6).toFixed(1)} MB, built on Node ${manifest.node} from the tree ${manifest.tree}, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    console.error(`ci-build-output: ${error.message}`);
    process.exit(1);
  }
}
