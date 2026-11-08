// Imports follow the layer direction. Each workspace package has one layer (LAYERS) and may reach only the layers below
// it (MAY): protocols reach nothing; the kernel reaches protocols; plug-ins reach protocols and the kernel; subsystems
// reach protocols, the kernel and (for now) each other; the server reaches anything; a surface reaches no workspace
// package and talks to the server through its API alone. An edge is a manifest dependency, or a quoted string in source
// that names a workspace package (an import, export-from, import(), require, import.meta.resolve, or a constant passed to
// one) or a relative path that lands in another package, or, in a surface, the name of one of the server's own data files.
// Tests, fixtures, vendor and dist are not read, nor devDependencies (build and test time only); source is read by TypeScript's
// parser, so only real string literals count (never a comment, a regular expression or template text). Today's wrong edges are EXCEPTIONS, each with its count, reason and fix:
// a new wrong edge fails, and so does an exception that no longer occurs in full, so the table only shrinks.
// `node scripts/check-direction.mjs` exits non-zero with the problems (`--list` prints every wrong edge, excepted or not);
// check-direction.test.mjs runs it on this tree and on planted breaks.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isMain } from './is-main.mjs';

/** Every workspace directory (packages/* and apps/*) has exactly one layer here. */
export const LAYERS = {
  // None yet: the wire protocols (run control, the computer daemon) and the DecisionProvider interface land here as they
  // move out of the packages below.
  protocol: [],
  kernel: ['packages/run-adapters'],
  'plug-in': ['packages/run-adapters-claude-agent', 'packages/run-adapters-codex', 'packages/computer', 'packages/decisions', 'packages/jev'],
  // Libraries to be folded into the kernel, a plug-in or the server. packages/dsl is the workflow language and its engine.
  subsystem: [
    'packages/dsl', 'packages/harness', 'packages/pi', 'packages/pi-browser',
    'packages/pi-durable-agent', 'packages/pi-durable-disk', 'packages/pi-transport', 'packages/pi-vision',
  ],
  server: ['packages/serve'],
  surface: ['apps/console', 'apps/viewer', 'packages/agentrun', 'packages/client'],
};

/** The layers each layer may reach, besides its own package. */
export const MAY = {
  protocol: [],
  kernel: ['protocol'],
  'plug-in': ['protocol', 'kernel'],
  subsystem: ['protocol', 'kernel', 'subsystem'],
  server: Object.keys(LAYERS),
  surface: [],
};

const KERNEL_DSL = ['the kernel takes the workflow types and parameter check from the DSL', 'run workflows as a harness on the kernel, so the kernel names no workflow type'];
const DECLARED_DSL = ['a declared dependency on the DSL that no source file imports', 'delete it from the manifest'];
const PROVIDER_DSL = ['the DecisionProvider interface and its helpers live in the DSL', 'move the interface into a protocol package'];
const PI_JEV = ['the Pi runtime builds the Jev decision provider itself', 'workflows run as a harness and are handed their decision providers'];
const CONSOLE_SOURCE = ['the console compiles library source through a path alias (tsconfig paths and the Vite alias)', 'fold the library into the server and serve what the console needs through the API'];
const LAUNCHER_SERVER = ['the launcher installs the server at its own version and runs its start script', 'the server package carries its own start command'];

/** Today's wrong edges: [file, the package it reaches, how many edges, why it is there, the change that removes it]. The
 *  count is exact, so a new edge to the same package fails, and so does a fix that leaves the count behind. The check
 *  names each edge's file:line when it fails; `node scripts/check-direction.mjs --list` prints them all. */
export const EXCEPTIONS = [
  ['packages/run-adapters/package.json', 'packages/dsl', 1, ...KERNEL_DSL],
  ['packages/run-adapters/src/runner.ts', 'packages/dsl', 1, ...KERNEL_DSL],
  ['packages/run-adapters/src/types.ts', 'packages/dsl', 1, ...KERNEL_DSL],
  ['packages/run-adapters-claude-agent/package.json', 'packages/dsl', 1, ...DECLARED_DSL],
  ['packages/run-adapters-codex/package.json', 'packages/dsl', 1, ...DECLARED_DSL],
  ['packages/decisions/package.json', 'packages/dsl', 1, ...PROVIDER_DSL],
  ['packages/decisions/src/evidence.ts', 'packages/dsl', 1, ...PROVIDER_DSL],
  ['packages/decisions/src/openrouter.ts', 'packages/dsl', 2, ...PROVIDER_DSL],
  ['packages/decisions/src/parallel.ts', 'packages/dsl', 2, ...PROVIDER_DSL],
  ['packages/jev/package.json', 'packages/dsl', 1, ...PROVIDER_DSL],
  ['packages/jev/src/index.ts', 'packages/dsl', 2, ...PROVIDER_DSL],
  ['packages/pi/package.json', 'packages/jev', 1, ...PI_JEV],
  ['packages/pi/src/extension.ts', 'packages/jev', 1, ...PI_JEV],
  ['packages/pi/src/extension-service.ts', 'packages/jev', 1, 'the Pi runtime reads Jev\'s error type to report a failed decision', 'the same change: the provider reports its own failures'],
  ['apps/console/tsconfig.json', 'packages/dsl', 1, ...CONSOLE_SOURCE],
  ['apps/console/tsconfig.json', 'packages/pi-browser', 1, ...CONSOLE_SOURCE],
  ['apps/console/tsconfig.json', 'packages/pi-durable-agent', 1, ...CONSOLE_SOURCE],
  ['apps/console/vite.config.ts', 'packages/dsl', 1, ...CONSOLE_SOURCE],
  ['apps/console/vite.config.ts', 'packages/pi-browser', 1, ...CONSOLE_SOURCE],
  ['apps/console/vite.config.ts', 'packages/pi-durable-agent', 1, ...CONSOLE_SOURCE],
  ['packages/agentrun/package.json', 'packages/serve', 1, ...LAUNCHER_SERVER],
  ['packages/agentrun/lib/start.mjs', 'packages/serve', 2, ...LAUNCHER_SERVER],
  ['packages/agentrun/lib/cli.mjs', 'packages/serve', 3, 'the CLI finds the local server and its token by reading the server\'s data files', 'the CLI takes the address and token from its config or the environment, or asks the server through its API'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor', 'fixtures', 'test', 'tests', '__tests__', 'coverage']);
const SOURCE = /(?:\.[cm]?[jt]sx?|^tsconfig[^/]*\.json)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MANIFEST_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const posix = (path) => path.split(sep).join('/');

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) out.push(...await sourceFiles(path)); }
    else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(path);
  }
  return out;
}

async function workspaces(root) {
  const out = [];
  for (const parent of ['packages', 'apps']) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true }).catch(() => [])) {
      const dir = `${parent}/${entry.name}`;
      if (!entry.isDirectory()) continue;
      const manifest = await readFile(join(root, dir, 'package.json'), 'utf8').catch(() => undefined);
      if (manifest !== undefined) out.push({ dir, manifestText: manifest, manifest: JSON.parse(manifest) });
    }
  }
  return out;
}

/** The server's own data files, as a surface would name them: every `export const *_FILE = "..."` in its files module. */
async function serverFiles(root, layers) {
  const names = new Set();
  for (const dir of layers.server ?? []) {
    const text = await readFile(join(root, dir, 'src/files.ts'), 'utf8').catch(() => '');
    for (const match of text.matchAll(/^export const \w+_FILE = "([^"]+)";/gm)) names.add(match[1]);
  }
  return names;
}


/** Every string literal in a source file, read by TypeScript's own parser, so comments, regular expressions and template
 *  text are never mistaken for one: { value, line }. */
function literalsIn(file, text) {
  const kind = file.endsWith('.json') ? ts.ScriptKind.JSON : /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node)) out.push({ value: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** A tsconfig's `paths` targets, each resolved as TypeScript does: against `baseUrl` when set, else the file's own
 *  directory. Map of the target as written to its absolute path. */
function pathTargets(file, text) {
  if (!/(^|[\\/])tsconfig[^\\/]*\.json$/.test(file)) return new Map();
  const options = ts.parseConfigFileTextToJson(file, text).config?.compilerOptions ?? {};
  const base = resolve(dirname(file), typeof options.baseUrl === 'string' ? options.baseUrl : '.');
  const targets = Object.values(options.paths ?? {}).flat().filter((target) => typeof target === 'string');
  return new Map(targets.map((target) => [target, resolve(base, target)]));
}

/** Every edge from one workspace to another: { file, line, from, to, via }. */
export async function edges(root, layers = LAYERS) {
  const all = await workspaces(root);
  const byName = new Map(all.map((w) => [w.manifest.name, w.dir]));
  const dataFiles = await serverFiles(root, layers);
  const surfaces = new Set(layers.surface ?? []);
  const owner = (abs) => all.find((w) => abs === resolve(root, w.dir) || abs.startsWith(resolve(root, w.dir) + sep))?.dir;
  const found = [];
  for (const { dir, manifest, manifestText } of all) {
    for (const field of MANIFEST_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const to = byName.get(name);
        if (to && to !== dir) found.push({ file: `${dir}/package.json`, line: lineOf(manifestText, manifestText.indexOf(`"${name}"`, manifestText.indexOf(`"${field}"`))), from: dir, to, via: `${field} ${name}` });
      }
    }
    for (const file of await sourceFiles(join(root, dir))) {
      const text = await readFile(file, 'utf8');
      const rel = posix(relative(root, file));
      const aliases = pathTargets(file, text);
      // A string with no space in it: a module specifier, a path or a file name. Prose has spaces, so it never matches.
      for (const { value, line } of literalsIn(file, text)) {
        if (!value || /\s/.test(value)) continue;
        let to;
        if (aliases.has(value)) to = owner(aliases.get(value));
        else if (/^\.\.?\//.test(value)) to = owner(resolve(dirname(file), value));
        else if (surfaces.has(dir) && dataFiles.has(value)) to = layers.server[0];
        else to = byName.get(value) ?? byName.get(value.split('/').slice(0, value.startsWith('@') ? 2 : 1).join('/'));
        if (to && to !== dir) found.push({ file: rel, line, from: dir, to, via: value });
      }
    }
  }
  return found;
}

/** Problems in the workspace at `root`; empty passes. */
export async function directionProblems(root, { layers = LAYERS, may = MAY, exceptions = EXCEPTIONS } = {}) {
  const layerOf = new Map(Object.entries(layers).flatMap(([layer, dirs]) => dirs.map((dir) => [dir, layer])));
  const problems = [];
  const present = new Set((await workspaces(root)).map((w) => w.dir));
  for (const dir of present) if (!layerOf.has(dir)) problems.push(`${dir} has no layer: add it to LAYERS in scripts/check-direction.mjs`);
  for (const dir of layerOf.keys()) if (!present.has(dir)) problems.push(`LAYERS names ${dir}, which is not a workspace: delete it`);
  const allowed = new Map(exceptions.map(([file, to, count]) => [`${file} -> ${to}`, { count, seen: [] }]));
  for (const edge of await edges(root, layers)) {
    const from = layerOf.get(edge.from);
    const to = layerOf.get(edge.to);
    if (!from || !to || may[from].includes(to)) continue;
    const message = `${edge.file}:${edge.line}: ${edge.from} (${from}) reaches ${edge.to} (${to}) by '${edge.via}'; a ${from} may reach ${may[from].length ? `only ${may[from].join(', ')}` : 'no workspace package'}`;
    const exception = allowed.get(`${edge.file} -> ${edge.to}`);
    if (exception) exception.seen.push(message);
    else problems.push(message);
  }
  for (const [key, { count, seen }] of allowed) {
    if (!seen.length) problems.push(`exception ${key} no longer occurs: delete it from EXCEPTIONS`);
    else if (seen.length > count) problems.push(...seen.map((message) => `${message} (exception ${key} allows ${count}, ${seen.length} found)`));
    else if (seen.length < count) problems.push(`exception ${key} allows ${count}, ${seen.length} found: lower its count in EXCEPTIONS`);
  }
  return problems;
}

if (isMain(import.meta)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  if (process.argv.includes('--list')) {
    const layerOf = new Map(Object.entries(LAYERS).flatMap(([layer, dirs]) => dirs.map((dir) => [dir, layer])));
    for (const e of await edges(root)) if (!MAY[layerOf.get(e.from)]?.includes(layerOf.get(e.to))) console.log(`${e.file}:${e.line} ${e.from} -> ${e.to} '${e.via}'`);
  } else {
    const problems = await directionProblems(root);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exit(1);
    console.log(`Imports follow the layer direction (${EXCEPTIONS.length} known exceptions).`);
  }
}
