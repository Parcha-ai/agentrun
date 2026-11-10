// The child a crash test spawns. By default it is the test's own fixture. With PI_CROSS_FIRST and PI_CROSS_LATER set
// (directories holding a copy of these fixtures inside an install of the packages on one pi version each), it is a
// dispatcher: the first process that starts a run (`start` on a store or directory no process started before) runs
// PI_CROSS_FIRST's copy, and every later process (a `resume`, a later `start`) runs PI_CROSS_LATER's. So the run begins
// on one pi version, is killed there, and every process after that opens its store on the other. PI_CROSS_STATE is the
// directory where the dispatchers and their marks of started runs are kept.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PI_CROSS_FIRST: first, PI_CROSS_LATER: later, PI_CROSS_STATE: state } = process.env;

/** Whether the crash tests run across two pi versions. */
export const crossVersion = Boolean(first && later && state);

/** The fixture `name` inside the install that runs first (`first`) or later (`later`), across two pi versions. */
export const crossFixture = (name, which) => join(which === 'first' ? first : later, name);

/** The path to spawn for the fixture `name` (a file in this directory). */
export function childPath(name) {
  if (!crossVersion) return fileURLToPath(new URL(`./${name}`, import.meta.url));
  mkdirSync(join(state, 'marks'), { recursive: true });
  const dispatcher = join(state, `dispatch-${createHash('sha256').update(name).digest('hex').slice(0, 12)}.mjs`);
  writeFileSync(dispatcher, `import { existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [mode, at] = process.argv.slice(2);
const mark = ${JSON.stringify(join(state, 'marks'))} + '/' + createHash('sha256').update(String(at)).digest('hex');
const isFirst = mode === 'start' && !existsSync(mark);
if (isFirst) writeFileSync(mark, '');
await import(pathToFileURL(isFirst ? ${JSON.stringify(join(first, name))} : ${JSON.stringify(join(later, name))}).href);
`);
  return dispatcher;
}
