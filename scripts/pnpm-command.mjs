// pnpm as a child process of a repository script, never through a shell. That is the pnpm that ran the script: under
// `pnpm run` or `pnpm exec`, npm_execpath names pnpm's own executable (its native binary, or the Node script a Corepack
// or Node-run pnpm is, run with this node). Else `pnpm` from PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

/** What to spawn to run pnpm with `args`: `{ command, args }`. `env`, `execPath` and `exists` are the process's own unless
 *  a test passes them. */
export function pnpmCommand(args, { env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const ran = env.npm_execpath;
  const name = ran ? basename(ran.replaceAll('\\', '/')).toLowerCase() : '';
  if (ran && /^pnpm(?:\.exe)?$/.test(name) && exists(ran)) return { command: ran, args };
  if (ran && /^pnpm\.[cm]?js$/.test(name) && exists(ran)) return { command: execPath, args: [ran, ...args] };
  return { command: 'pnpm', args };
}

/** child_process.spawnSync of pnpm with `args`. */
export function pnpmSpawnSync(args, options = {}) {
  const c = pnpmCommand(args, { env: options.env ?? process.env });
  return spawnSync(c.command, c.args, options);
}
