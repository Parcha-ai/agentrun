// The console (apps/console: its own lockfile, outside the workspaces) built before the workspaces, so the server's build
// copies it into its dist and a fresh checkout's `npm ci && npm run build` serves it. It installs the console's
// dependencies when they are not the ones its lockfile names (npm's own record of what it installed,
// node_modules/.package-lock.json, read against the lockfile), and skips the build when the console's dist was built from
// the same inputs: its sources, index.html, its configs, its lockfile and the package sources it imports (the DSL's, the
// timeline library's, pi-browser's core), hashed (a hash, not file times, so a branch switch or a touched file that did
// not change never fools it).
// `--stamp`: only record the inputs' hash in dist, after the console's own `npm run build` (CI's checks shard and the
// image build it themselves first; the root build then finds it current).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

/** The console's build inputs, below the repository's root: with its own, the sources it imports through its aliases
 *  (vite.config.ts): the DSL's, the timeline library's and pi-browser's core. */
const INPUTS = ['apps/console/src', 'apps/console/index.html', 'apps/console/package.json', 'apps/console/package-lock.json', 'apps/console/tsconfig.json', 'apps/console/vite.config.ts', 'apps/console/third-party-notices.mjs', 'apps/console/credential-gate.mjs', 'apps/console/tailwind.config.ts', 'apps/console/postcss.config.js', 'packages/dsl/src', 'packages/serve/src/timeline', 'packages/pi-browser/src/core'];
export const HASH_FILE = '.build-hash';

const filesUnder = (path) => (statSync(path).isDirectory() ? readdirSync(path).sort().flatMap((name) => filesUnder(join(path, name))) : [path]);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The hash of every input file's path and bytes, in a fixed order; an input that is not there counts as absent. */
export function consoleInputsHash(root) {
  const hash = createHash('sha256');
  for (const input of INPUTS) {
    const path = join(root, input);
    if (!existsSync(path)) { hash.update(`absent ${input}\0`); continue; }
    for (const file of filesUnder(path)) hash.update(`${relative(root, file).split(sep).join('/')}\0${sha256(readFileSync(file))}\0`);
  }
  return hash.digest('hex');
}

/** Whether apps/console/dist holds a build of the inputs as they are now. */
export function consoleIsCurrent(root) {
  const dist = join(root, 'apps', 'console', 'dist');
  return existsSync(join(dist, 'index.html')) && existsSync(join(dist, HASH_FILE)) && readFileSync(join(dist, HASH_FILE), 'utf8').trim() === consoleInputsHash(root);
}

export function stampConsole(root) {
  writeFileSync(join(root, 'apps', 'console', 'dist', HASH_FILE), `${consoleInputsHash(root)}\n`);
}

// `npm ci` runs through npm-ci-retry.mjs: once more after a network error, never after any other failure.
const NPM_CI_RETRY = fileURLToPath(new URL('./npm-ci-retry.mjs', import.meta.url));
const npm = (args, cwd) => {
  const [bin, argv] = args[0] === 'ci' ? [process.execPath, [NPM_CI_RETRY, ...args.slice(1)]] : [process.platform === 'win32' ? 'npm.cmd' : 'npm', args];
  const done = spawnSync(bin, argv, { cwd, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`npm ${args.join(' ')} in ${cwd} exited ${done.status ?? done.signal}`);
};

/** Whether apps/console/node_modules holds every package its lockfile names, at that version, by the record npm writes
 *  when it installs (optional packages aside: they are another platform's). */
export function consoleDepsInstalled(root) {
  const app = join(root, 'apps', 'console');
  try {
    const installed = JSON.parse(readFileSync(join(app, 'node_modules', '.package-lock.json'), 'utf8')).packages ?? {};
    const locked = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8')).packages ?? {};
    return Object.entries(locked).every(([path, entry]) => path === '' || entry.optional || installed[path]?.version === entry.version);
  } catch {
    return false;
  }
}

/** Builds the console unless it is current: `npm ci` first when its dependencies are not the lockfile's, then its own
 *  `npm run build`, which stamps the hash. `run` runs npm (tests pass their own). */
export function buildConsole(root, { run = npm, log = (line) => console.log(line) } = {}) {
  if (consoleIsCurrent(root)) { log('The console is current (apps/console/dist matches its sources): not built again.'); return 'current'; }
  const app = join(root, 'apps', 'console');
  if (!consoleDepsInstalled(root)) run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], app);
  run(['run', 'build'], app);
  if (!consoleIsCurrent(root)) throw new Error('apps/console built, but its dist does not record the inputs it was built from');
  return 'built';
}

if (isMain(import.meta)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--stamp')) stampConsole(root);
  else buildConsole(root);
}
