// The console (apps/console: its own lockfile, outside the workspaces) built before the workspaces, so the server's build
// copies it into its dist and a fresh checkout's `pnpm install && pnpm run build` serves it. It installs the console's
// dependencies when they are not the ones its lockfile names (pnpm's own record of what it installed,
// node_modules/.pnpm/lock.yaml, read against the lockfile), and skips the build when the console's dist was built from
// the same inputs: its sources, index.html, its configs, its lockfile and the package sources it imports (the DSL's, the
// timeline library's, serve's tool-name grammar, pi-browser's core), hashed (a hash, not file times, so a branch switch or a touched file that did
// not change never fools it).
// `--stamp`: only record the inputs' hash in dist, after the console's own `pnpm run build` (CI's checks shard and the
// image build it themselves first; the root build then finds it current).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { pnpmSpawnSync } from './pnpm-command.mjs';
import { readLock, readLockFile } from './pnpm-lock.mjs';

/** The console's build inputs, below the repository's root: with its own, the sources it imports through its aliases
 *  (vite.config.ts): the DSL's, the timeline library's, serve's tool-name grammar and pi-browser's core. */
const INPUTS = ['apps/console/src', 'apps/console/index.html', 'apps/console/package.json', 'apps/console/pnpm-lock.yaml', 'apps/console/pnpm-workspace.yaml', 'apps/console/tsconfig.json', 'apps/console/vite.config.ts', 'apps/console/third-party-notices.mjs', 'apps/console/credential-gate.mjs', 'apps/console/tailwind.config.ts', 'apps/console/postcss.config.js', 'packages/dsl/src', 'packages/serve/src/timeline', 'packages/serve/src/tool-names.ts', 'packages/web/src/text-urls.ts', 'packages/pi-browser/src/core'];
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

// pnpm retries a failed download itself (fetch-retries), so no wrapper retries the install.
const pnpm = (args, cwd) => {
  const done = pnpmSpawnSync(args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`pnpm ${args.join(' ')} in ${cwd} exited ${done.status ?? done.signal}`);
};

/** Whether apps/console/node_modules holds every package its lockfile names, as that lockfile resolves it, by the record
 *  pnpm writes when it installs (optional packages aside: they are another platform's). */
export function consoleDepsInstalled(root) {
  const app = join(root, 'apps', 'console');
  try {
    const installed = readLockFile(join(app, 'node_modules', '.pnpm', 'lock.yaml'));
    const locked = readLock(app);
    const importer = (lock) => JSON.stringify(lock.importers['.'] ?? {});
    return importer(installed) === importer(locked) && Object.entries(locked.snapshots).every(([key, snapshot]) => snapshot.optional || Object.hasOwn(installed.snapshots, key));
  } catch {
    return false;
  }
}

/** Builds the console unless it is current: `pnpm install --frozen-lockfile` first when its dependencies are not the
 *  lockfile's, then its own `pnpm run build`, which stamps the hash. `run` runs pnpm (tests pass their own). */
export function buildConsole(root, { run = pnpm, log = (line) => console.log(line) } = {}) {
  if (consoleIsCurrent(root)) { log('The console is current (apps/console/dist matches its sources): not built again.'); return 'current'; }
  const app = join(root, 'apps', 'console');
  if (!consoleDepsInstalled(root)) run(['install', '--frozen-lockfile'], app);
  run(['run', 'build'], app);
  if (!consoleIsCurrent(root)) throw new Error('apps/console built, but its dist does not record the inputs it was built from');
  return 'built';
}

if (isMain(import.meta)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--stamp')) stampConsole(root);
  else buildConsole(root);
}
