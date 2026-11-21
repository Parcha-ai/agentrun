// npm as a child process of a repository script, on every platform. Node on Windows won't spawn npm.cmd without a shell
// (CVE-2024-27980), and plain `npm` doesn't resolve there at all (#3334), so a script never spawns npm by name: it runs
// npm's own CLI script with this node, as serve's npmCommand (packages/serve/src/harness-install.ts) does. That is the
// npm that ran the script (npm_execpath, under `npm run` or `npm exec`), else the one installed with this node. Only
// with neither is npm spawned by name: `npm` on PATH, or on Windows `npm.cmd` through cmd.exe, each argument quoted.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

/** cmd.exe's reading of one argument: as it is when nothing in it is special to cmd, else in double quotes with each
 *  quote doubled and each % doubled (cmd expands %VAR% even inside quotes). */
export function cmdQuote(arg) {
  return /^[\w@./:=,+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

/** What to spawn to run npm with `args`: `{ command, args, shell }`. `env`, `platform`, `execPath` and `exists` are the
 *  process's own unless a test passes them. */
export function npmCommand(args, { env = process.env, platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  const ran = env.npm_execpath;
  if (ran && /\.c?js$/.test(ran) && exists(ran)) return { command: execPath, args: [ran, ...args], shell: false };
  const node = dirname(execPath);
  // POSIX installs put npm in <prefix>/lib/node_modules, beside <prefix>/bin/node; Windows ones beside node.exe.
  for (const beside of [join(node, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (exists(beside)) return { command: execPath, args: [beside, ...args], shell: false };
  }
  if (platform === 'win32') return { command: ['npm.cmd', ...args.map(cmdQuote)].join(' '), args: [], shell: true };
  return { command: 'npm', args, shell: false };
}

/** child_process.spawnSync of npm with `args`. */
export function npmSpawnSync(args, options = {}) {
  const c = npmCommand(args, { env: options.env ?? process.env });
  return spawnSync(c.command, c.args, { ...options, shell: c.shell });
}

/** child_process.spawn of npm with `args`. */
export function npmSpawn(args, options = {}) {
  const c = npmCommand(args, { env: options.env ?? process.env });
  return spawn(c.command, c.args, { ...options, shell: c.shell });
}

const execFileAsync = promisify(execFile);
/** promisify(execFile) of npm with `args`: `{ stdout, stderr }`, rejecting as execFile does. */
export function npmExecFile(args, options = {}) {
  const c = npmCommand(args, { env: options.env ?? process.env });
  return execFileAsync(c.command, c.args, { ...options, shell: c.shell });
}
