// npm as a child process of a repository script, on every platform. Node on Windows won't spawn npm.cmd without a shell
// (CVE-2024-27980), and plain `npm` doesn't resolve there at all (#3334), so a script never spawns npm by name: it runs
// npm's own CLI script with this node, as serve's npmCommand (packages/serve/src/harness-install.ts) does. That is the
// npm that ran the script (npm_execpath, under `npm run` or `npm exec`), else the one installed with this node. Only
// with neither is `npm` spawned by name, from PATH; on Windows that fails as it did before, never through a shell.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';

/** What to spawn to run npm with `args`: `{ command, args }`, never through a shell. `env`, `platform`, `execPath` and
 *  `exists` are the process's own unless a test passes them. */
export function npmCommand(args, { env = process.env, platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  // The platform's own paths, so a test of another platform gets that platform's.
  const { dirname, join } = platform === 'win32' ? win32 : posix;
  const ran = env.npm_execpath;
  if (ran && /\.c?js$/.test(ran) && exists(ran)) return { command: execPath, args: [ran, ...args] };
  const node = dirname(execPath);
  // POSIX installs put npm in <prefix>/lib/node_modules, beside <prefix>/bin/node; Windows ones beside node.exe.
  for (const beside of [join(node, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (exists(beside)) return { command: execPath, args: [beside, ...args] };
  }
  return { command: 'npm', args };
}

/** child_process.spawnSync of npm with `args`. */
export function npmSpawnSync(args, options = {}) {
  const c = npmCommand(args, { env: options.env ?? process.env });
  return spawnSync(c.command, c.args, options);
}

/** child_process.spawn of npm with `args`. */
export function npmSpawn(args, options = {}) {
  const c = npmCommand(args, { env: options.env ?? process.env });
  return spawn(c.command, c.args, options);
}

const execFileAsync = promisify(execFile);
/** promisify(execFile) of npm with `args`: `{ stdout, stderr }`, rejecting as execFile does. */
export function npmExecFile(args, options = {}) {
  const c = npmCommand(args, { env: options.env ?? process.env });
  return execFileAsync(c.command, c.args, options);
}

/** child_process.spawn of a command given as argv: npm through its own CLI script when argv[0] is `npm`, else as
 *  written. */
export function spawnArgv([command, ...args], options = {}) {
  return command === 'npm' ? npmSpawn(args, options) : spawn(command, args, options);
}

/** child_process.spawnSync of a command given as argv, as spawnArgv. */
export function spawnArgvSync([command, ...args], options = {}) {
  return command === 'npm' ? npmSpawnSync(args, options) : spawnSync(command, args, options);
}
