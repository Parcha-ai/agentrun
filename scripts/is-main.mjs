// How a script decides it is the command: `if (isMain(import.meta)) ...`. Where Node sets import.meta.main (22.18 and later
// on 22, 24.2 and later) the answer is that value. Where it does not (Node 20, 23, 24.0-24.1) `if (import.meta.main)` is
// false for the command too, and the script exits 0 having done nothing: a `--check` that checked nothing. There this
// refuses the command, with one line on stderr and exit code 1, and leaves a module that is only imported alone, so a test
// importing a script's functions runs on. `node script.mjs` reads no `engines`, hence the check at run time. For the
// scripts here, which run from their place in the repository: examples and package fixtures, copied elsewhere, keep
// import.meta.main (entry-points.test.mjs lists them). Plain JavaScript and builtins only, to load on any Node.
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

function pinned() {
  try { return ` (.nvmrc pins ${readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim()}; with nvm: nvm install && nvm use)`; } catch { return ''; }
}

/** Whether the module whose `import.meta` this is runs as the command. */
export function isMain(meta) {
  if (meta.main !== undefined) return meta.main;
  // Node resolves the module's URL through symlinks and leaves argv[1] as given, so both sides go through realpath.
  const entry = process.argv[1];
  if (!entry || real(entry) !== real(fileURLToPath(meta.url))) return false;
  console.error(`${relative(process.cwd(), entry)}: refused on Node ${process.version}, which has no import.meta.main to tell this script it is the command (it would exit 0 having done nothing). AgentRun needs Node.js 22.19 or newer on 22, or 24.2 or newer${pinned()}.`);
  process.exitCode = 1;
  return false;
}
