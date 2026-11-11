// The tests a change reaches: `node scripts/test-affected.mjs` maps the paths changed since a base to the test files they
// reach and prints a command per suite that runs only those. A round runs these; CI on the pushed head runs every suite.
//   node scripts/test-affected.mjs [--base <ref>] [--stdin] [<path>...] [--list | --json | --run] [--concurrency <n>] [--no-smoke]
// - The changed paths: those given on argv, or one per line on stdin with --stdin; with neither, every file changed since
//   the merge base of HEAD and <ref> (default origin/untangle/cutover, else origin/main), committed, staged, unstaged and
//   untracked, as `npm run test:changed` reads them.
// - The suites are CI's (readSuites in scripts/ci-plan.mjs: each workspace's test script, test:release, test:examples) and
//   the console's vitest files. A whole suite (pi-browser's runner) lists its files with --list and runs the files it is given.
// - What a changed path picks, each test file with the reason (`kind`):
//   test      a test file of a suite picks itself.
//   import    a file a test imports, directly or through other files, picks that test. Imports are read from each file's
//             parse tree: import and export from (not a type-only one: it is erased before the code runs), require(),
//             import(), require.resolve(), import.meta.resolve() and new URL('<relative path>', import.meta.url). A
//             relative path, a workspace package's name (through its "exports", the "source" condition first) and a
//             tsconfig "paths" alias resolve to a file in the repository, and a built file maps back to its source by the
//             outDir and rootDir of the tsconfig its package's build compiles (dist/x.js to src/x.ts).
//   package   a package's package.json, tsconfig*.json, vite or vitest config, or a file its build or test script names,
//             picks every test file of the package.
//   fallback  where the parse tree cannot be sure (a computed import(), a path built from strings, a fixture read by path),
//             a file of the path's package that names the path's file (its basename; for a source file its path under
//             src/, as .ts or .js) picks the tests that are or import that file; for a code file, only a file outside the
//             package's source counts. A code file no test reaches either way
//             picks its package's test files that import by a computed path themselves.
//   smoke     SMOKE below, a fast file per package, always (--no-smoke drops it), so a round catches a gross break.
//   A shared root (SHARED_ROOTS: the root manifests, lockfile, scripts/, .github/) picks the tests that import it and the
//   smoke set only, not every suite, and says so: CI runs every suite on the pushed head.
// - Output: by default a shell command per suite, run from the root, on stdout, and what each changed path picked on stderr.
//   --list prints the picked test files, one per line, from the root. --json prints { base, changed, paths, suites }, with
//   each picked file's reasons: `{ kind, changed, chain }`, the chain running from the test to the changed path. --run runs
//   the commands, one suite at a time. --concurrency <n> caps the test files at once in each command: a `node --test`'s
//   --test-concurrency (lowered, never raised), and TEST_CONCURRENCY and VITEST_MAX_WORKERS for the others.
// Exit: 0, or with --run every command passed; 1 a command failed; 2 a usage error.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { readConfig, readSuites } from './ci-plan.mjs';
import { isMain } from './is-main.mjs';

/** A fast test file per suite, run on every round: suite name to its file, relative to the suite's directory. */
export const SMOKE = {
  '@parcha/agentrun': 'test/hardening.test.mjs',
  '@parcha/agentrun-client': 'test/rules.test.mjs',
  '@parcha/agentrun-computer': 'test/entry.test.mjs',
  '@parcha/agentrun-decisions': 'test/parallel.test.mjs',
  '@parcha/agentrun-dsl': 'test/job.test.mjs',
  '@parcha/agentrun-jev': 'test/adapter.test.mjs',
  '@parcha/agentrun-pi': 'test/pi.test.mjs',
  '@parcha/pi-browser': 'test/dial.test.mjs',
  '@parcha/pi-durable-agent': 'test/export.test.mjs',
  '@parcha/pi-durable-disk': 'test/package.test.ts',
  '@parcha/agentrun-kernel': 'test/kernel.test.mjs',
  '@parcha/agentrun-harness-claude': 'test/names.test.mjs',
  '@parcha/agentrun-harness-codex': 'test/machine.test.mjs',
  '@parcha/agentrun-serve': 'test/harness-default-model.test.mjs',
  'agentrun-console': 'src/App.setup.test.tsx',
};

/** Paths outside the packages that every suite may read: a change to one picks its importers and the smoke set only. */
export const SHARED_ROOTS = [/^package(-lock)?\.json$/, /^tsconfig\.base\.json$/, /^\.nvmrc$/, /^\.npmrc$/, /^scripts\//, /^\.github\//];

/** The defaults for --base, the first that names a commit. */
export const DEFAULT_BASES = ['origin/untangle/cutover', 'origin/main'];

// The console: outside the workspaces, its own lockfile; its test files are vite.config.ts's `test.include`.
const CONSOLE = { dir: 'apps/console', tests: ['src/**/*.test.ts', 'src/**/*.test.tsx'], run: 'vitest run' };
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const CONFIG = /^(?:package\.json|package-lock\.json|tsconfig(?:\.[\w-]+)?\.json|vite(?:st)?\.config\.[cm]?[jt]s)$/;
const toPosix = (path) => path.split(sep).join('/');

class Usage extends Error {}

/** The repository's packages (packages/* and the console): `{ name, dir, manifest, outDir, rootDir, aliases, named }`. */
export function readPackages(root) {
  fileCache.clear();
  const dirs = [...globSync('packages/*/package.json', { cwd: root }).map((path) => toPosix(dirname(path))).sort(), CONSOLE.dir]
    .filter((dir) => existsSync(join(root, dir, 'package.json')));
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const scripts = [manifest.scripts?.build, manifest.scripts?.test].filter(Boolean).join(' ');
    // The tsconfig the build compiles (`tsc -p <file>`), else tsconfig.json: its outDir and rootDir map dist/ to src/.
    const project = /\btsc\b[^&;|]*?-p\s+(\S+)/.exec(manifest.scripts?.build ?? '')?.[1] ?? 'tsconfig.json';
    const built = compilerOptions(join(root, dir, project));
    const own = compilerOptions(join(root, dir, 'tsconfig.json'));
    const base = own.baseUrl ? posix.join(dir, toPosix(own.baseUrl)) : dir;
    const aliases = Object.entries(own.paths ?? {}).map(([pattern, targets]) => ({ pattern, targets: targets.map((target) => posix.join(base, toPosix(target))) }));
    // The files the build and test scripts name (`node scripts/copy-page.mjs`, `tsc -p tsconfig.build.json`).
    const named = [...new Set(scripts.split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, ''))
      .filter((word) => /^[\w./-]+\.\w+$/.test(word))
      .map((word) => posix.normalize(posix.join(dir, word)))
      .filter((path) => !path.startsWith('..') && isFile(root, path)))];
    return {
      name: manifest.name, dir, manifest, aliases, named,
      outDir: built.outDir && built.noEmit !== true ? posix.join(dir, toPosix(built.outDir)) : undefined,
      rootDir: posix.join(dir, toPosix(built.rootDir ?? 'src')),
    };
  });
}

// A tsconfig's compilerOptions, its `extends` (a relative path) under them.
function compilerOptions(path, depth = 0) {
  if (depth > 5 || !existsSync(path)) return {};
  const { config } = ts.readConfigFile(path, ts.sys.readFile);
  const parent = typeof config?.extends === 'string' && config.extends.startsWith('.') ? compilerOptions(resolve(dirname(path), config.extends), depth + 1) : {};
  return { ...parent, ...config?.compilerOptions };
}

const fileCache = new Map();
function isFile(root, path) {
  const key = `${root}\0${path}`;
  if (!fileCache.has(key)) { let file = false; try { file = statSync(join(root, path)).isFile(); } catch { /* not there */ } fileCache.set(key, file); }
  return fileCache.get(key);
}

/** The suites: `{ name, dir, files, command(files, { concurrency }) }`, `dir` and `files` relative to the root and `dir`. */
export function readTestSets(root) {
  const config = existsSync(join(root, 'scripts', 'ci-shards.json')) ? readConfig(root).config : { rootSuites: [], whole: {} };
  const sets = readSuites(root, { config }).map((suite) => {
    if (!suite.whole) {
      return { name: suite.name, dir: suite.cwd, files: suite.files, command: (files, { concurrency } = {}) => {
        const argv = suite.run(files);
        const at = argv.indexOf('-c') + 1;
        if (/^node --test( |$)/.test(argv[at])) {
          if (concurrency) argv[at] = cappedNodeTest(argv[at], concurrency);
          return { argv, env: {} };
        }
        return { argv, env: concurrency ? knobs(concurrency) : {} };
      } };
    }
    // A whole suite's runner lists the files it runs with --list, and runs only the files it is given.
    const script = suite.workspace ? JSON.parse(readFileSync(join(root, suite.cwd, 'package.json'), 'utf8')).scripts.test : config.whole[suite.name];
    const where = suite.workspace ? ['-w', suite.workspace] : [];
    const listed = spawnSync('npm', ['exec', ...where, '-c', `${script} --list`], { cwd: root, encoding: 'utf8' });
    if (listed.status !== 0) throw new Error(`${suite.name}: \`${script} --list\` exited ${listed.status ?? listed.signal}: ${(listed.stderr || '').trim().split('\n').slice(-2).join(' / ')}`);
    const files = [...new Set(listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean))].sort();
    return { name: suite.name, dir: suite.cwd, files, command: (some, { concurrency } = {}) => ({
      argv: ['npm', 'exec', ...where, '-c', [script, ...some].join(' ')], env: concurrency ? knobs(concurrency) : {},
    }) };
  });
  if (existsSync(join(root, CONSOLE.dir, 'package.json'))) {
    const manifest = JSON.parse(readFileSync(join(root, CONSOLE.dir, 'package.json'), 'utf8'));
    const files = [...new Set(CONSOLE.tests.flatMap((pattern) => globSync(pattern, { cwd: join(root, CONSOLE.dir) }).map(toPosix)))].sort();
    if (manifest.scripts?.test === CONSOLE.run && files.length) {
      sets.push({ name: manifest.name, dir: CONSOLE.dir, files, command: (some, { concurrency } = {}) => ({
        argv: ['npm', 'exec', '-c', [CONSOLE.run, ...some].join(' ')], cwd: CONSOLE.dir, env: concurrency ? knobs(concurrency) : {},
      }) });
    }
  }
  return sets;
}

const knobs = (n) => ({ TEST_CONCURRENCY: String(n), VITEST_MAX_WORKERS: String(n) });
function cappedNodeTest(text, n) {
  const own = /(?:^| )--test-concurrency=(\d+)(?= |$)/.exec(text);
  if (own) return text.replace(own[0], ` --test-concurrency=${Math.min(Number(own[1]), n)}`).replace(/^ /, '');
  return text.replace(/^node --test/, `node --test --test-concurrency=${n}`);
}

/** The specifiers a file imports, and whether it also imports by a computed path. */
export function scan(text, file) {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const specifiers = [];
  let computed = false;
  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
  const isImportMetaUrl = (node) => node && ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression);
  const typeOnly = (clause) => !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)));
  const visit = (node) => {
    let specifier;
    // A type-only import or export is erased before the code runs: a test does not run what it names.
    if (ts.isImportDeclaration(node)) { if (!typeOnly(node.importClause)) specifier = literal(node.moduleSpecifier); }
    else if (ts.isExportDeclaration(node)) { if (!node.isTypeOnly && !(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every((e) => e.isTypeOnly))) specifier = literal(node.moduleSpecifier); }
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) { if (!node.isTypeOnly) specifier = literal(node.moduleReference.expression); }
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ((ts.isIdentifier(callee.expression) && callee.expression.text === 'require') || ts.isMetaProperty(callee.expression)));
      if (loads && node.arguments.length) {
        specifier = literal(node.arguments[0]);
        if (specifier === undefined) computed = true;
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && isImportMetaUrl(node.arguments?.[1])) {
      const path = literal(node.arguments[0]);
      if (path !== undefined && path.startsWith('.')) specifier = path;
    }
    if (specifier !== undefined) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind));
  return { specifiers, computed };
}

/** Resolves a specifier in a file (both relative to the root) to a file of the repository, or undefined. */
export function resolver(root, packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
  const owner = (path) => packages.filter((pkg) => inside(path, pkg.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const file = (path) => (isFile(root, path) ? path : undefined);
  const SOURCE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx'];
  // A path to a file: a built file to its source, a `.js` that TypeScript names to its `.ts`, an extensionless one with
  // its extension or index.
  const fileFor = (path) => {
    path = posix.normalize(path);
    if (path.startsWith('..') || path.split('/').includes('node_modules')) return undefined;
    const pkg = owner(path);
    if (pkg?.outDir && inside(path, pkg.outDir)) {
      const rest = path.slice(pkg.outDir.length + 1);
      const stem = rest.replace(/(?:\.d)?\.[cm]?js$|\.d\.[cm]?ts$/, '');
      if (stem !== rest) for (const ext of SOURCE) { const found = file(`${pkg.rootDir}/${stem}${ext}`); if (found) return found; }
      return file(`${pkg.rootDir}/${rest}`);
    }
    if (file(path)) return path;
    const stem = path.replace(/\.([cm]?)js$/, '');
    if (stem !== path) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) { const found = file(stem + ext); if (found) return found; }
    for (const ext of [...SOURCE, '.json']) { const found = file(path + ext); if (found) return found; }
    for (const ext of SOURCE) { const found = file(`${path}/index${ext}`); if (found) return found; }
    return undefined;
  };
  return (from, specifier) => {
    specifier = specifier.replace(/[?#].*$/, '');
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (specifier.startsWith('/')) return undefined;
      return fileFor(posix.join(posix.dirname(from), specifier));
    }
    if (/^[a-z]+:/i.test(specifier)) return undefined;
    const pkg = owner(from);
    for (const { pattern, targets } of pkg?.aliases ?? []) {
      const star = pattern.indexOf('*');
      const match = star < 0 ? (specifier === pattern ? '' : undefined)
        : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1)) && specifier.length >= pattern.length - 1
          ? specifier.slice(star, specifier.length - (pattern.length - star - 1)) : undefined;
      if (match === undefined) continue;
      for (const target of targets) { const found = fileFor(target.replace('*', match)); if (found) return found; }
    }
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const target = byName.get(name);
    if (!target) return undefined;
    const sub = `.${specifier.slice(name.length)}`;
    const entry = exportTarget(target.manifest, sub);
    return entry === undefined ? undefined : fileFor(posix.join(target.dir, entry));
  };
}

const CONDITIONS = ['source', 'import', 'node', 'default', 'require', 'types'];
function pick(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { for (const item of value) { const found = pick(item); if (found) return found; } return undefined; }
  if (value && typeof value === 'object') for (const condition of CONDITIONS) if (condition in value) { const found = pick(value[condition]); if (found) return found; }
  return undefined;
}

/** The file a package's subpath (`.` or `./x`) names through its manifest's "exports" (or "main"), or undefined. */
export function exportTarget(manifest, sub) {
  const { exports } = manifest;
  if (exports === undefined) return sub === '.' ? manifest.main ?? 'index.js' : sub;
  if (typeof exports === 'string' || Array.isArray(exports) || !Object.keys(exports).some((key) => key.startsWith('.'))) return sub === '.' ? pick(exports) : undefined;
  if (sub in exports) return exports[sub] === null ? undefined : pick(exports[sub]);
  let best;
  for (const key of Object.keys(exports)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [before, after] = [key.slice(0, star), key.slice(star + 1)];
    if (sub.startsWith(before) && sub.endsWith(after) && sub.length >= key.length - 1 && (!best || before.length > best.before.length)) best = { key, before, after };
  }
  if (!best || exports[best.key] === null) return undefined;
  const found = pick(exports[best.key]);
  return found?.replaceAll('*', sub.slice(best.before.length, sub.length - best.after.length));
}

/** The import graph from `roots`: `{ edges: Map<file, Set<file>>, computed: Set<file>, texts: Map<file, string> }`. */
export function buildGraph(root, roots, resolve) {
  const edges = new Map(), computed = new Set(), texts = new Map();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (edges.has(file)) continue;
    const out = new Set();
    edges.set(file, out);
    if (!CODE.test(file) || !isFile(root, file)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    texts.set(file, text);
    const found = scan(text, file);
    if (found.computed) computed.add(file);
    for (const specifier of found.specifiers) {
      const target = resolve(file, specifier);
      if (target && target !== file) { out.add(target); if (!edges.has(target)) queue.push(target); }
    }
  }
  return { edges, computed, texts };
}

// The tests that reach `start` through the reversed graph, each with its chain from the test to `start`.
function reachers(reverse, tests, start) {
  const parent = new Map([[start, undefined]]);
  const queue = [start];
  const found = [];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (tests.has(at)) {
      const chain = [];
      for (let step = at; step !== undefined; step = parent.get(step)) chain.push(step);
      found.push({ test: at, chain });
    }
    for (const next of reverse.get(at) ?? []) if (!parent.has(next)) { parent.set(next, at); queue.push(next); }
  }
  return found;
}

// What names a file where a test reads it by path. A file of a package's source goes by its path under the source folder,
// as source or built (src/store/runs.ts: store/runs.ts or store/runs.js), right after the source or built folder's name or
// standing alone; a bare basename would match every same-named file (dist/runs.js is not src/store/runs.ts). Any other
// file goes by its basename.
function mentionOf(path, pkg) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!pkg || !path.startsWith(`${pkg.rootDir}/`)) return new RegExp(`(?<![\\w.-])${escape(basename(path))}(?![\\w-])`);
  const under = path.slice(pkg.rootDir.length + 1);
  const forms = [under];
  if (/\.(?:tsx?|mts|cts)$/.test(under) && !/\.d\.[cm]?ts$/.test(under)) forms.push(under.replace(/\.tsx?$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs'));
  const folders = [basename(pkg.rootDir), ...(pkg.outDir ? [basename(pkg.outDir)] : [])];
  const either = forms.map(escape).join('|');
  return new RegExp(`(?:(?<![\\w.-])(?:${folders.map(escape).join('|')})/|(?<![\\w./-]))(?:${either})(?![\\w-])`);
}

/**
 * What the changed paths pick: `{ suites: [{ name, dir, files, why }], paths: [{ path, kinds, note }], warnings }`.
 * `files` are relative to the suite's `dir`; `why` maps each to its reasons, `{ kind, changed, chain }` (paths from the root).
 */
export function select(root, changed, { sets = readTestSets(root), packages = readPackages(root), smoke = SMOKE } = {}) {
  const tests = new Map();
  for (const set of sets) for (const file of set.files) tests.set(set.dir === '.' ? file : `${set.dir}/${file}`, set);
  const resolve = resolver(root, packages);
  const graph = buildGraph(root, [...tests.keys()], resolve);
  const reverse = new Map();
  for (const [from, targets] of graph.edges) for (const to of targets) { if (!reverse.has(to)) reverse.set(to, []); reverse.get(to).push(from); }
  const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
  const ownerOf = (path) => packages.filter((pkg) => inside(path, pkg.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const setOf = (pkg) => sets.find((set) => set.dir === pkg.dir);
  const picks = new Map();
  const add = (test, reason) => {
    const set = tests.get(test);
    const file = set.dir === '.' ? test : test.slice(set.dir.length + 1);
    const mine = picks.get(set) ?? new Map();
    picks.set(set, mine);
    const reasons = mine.get(file) ?? [];
    mine.set(file, reasons);
    if (!reasons.some((seen) => seen.kind === reason.kind && seen.changed === reason.changed)) reasons.push(reason);
  };
  const paths = [];
  for (const path of [...new Set(changed)].sort()) {
    const picked = {};
    const count = (kind, test) => { (picked[kind] ??= new Set()).add(test); };
    let note;
    const exists = isFile(root, path);
    const pkg = ownerOf(path);
    const shared = !pkg && !tests.has(path) && SHARED_ROOTS.some((re) => re.test(path));
    if (tests.has(path)) {
      if (exists) { add(path, { kind: 'test', changed: path, chain: [path] }); count('test', path); } else note = 'a deleted test file';
    }
    let config = false;
    for (const owner of packages) {
      if (!(dirname(path) === owner.dir && CONFIG.test(basename(path))) && !owner.named.includes(path)) continue;
      config = true;
      const set = setOf(owner);
      for (const file of set?.files ?? []) {
        const test = set.dir === '.' ? file : `${set.dir}/${file}`;
        add(test, { kind: 'package', changed: path, chain: [path] });
        count('package', test);
      }
    }
    const byImport = new Set();
    if (graph.edges.has(path)) {
      for (const { test, chain } of reachers(reverse, tests, path)) if (test !== path) { add(test, { kind: 'import', changed: path, chain }); byImport.add(test); count('import', test); }
    }
    if (!shared && !config && !tests.has(path)) {
      const named = mentionOf(path, pkg);
      // For a code file, only the files outside the package's source (tests, their helpers and fixtures): a source file
      // naming it is an import the graph read, or a type-only one that runs nothing.
      const code = CODE.test(path);
      const scope = (file) => (pkg ? inside(file, pkg.dir) && !(code && inside(file, pkg.rootDir)) : !ownerOf(file));
      for (const [file, text] of graph.texts) {
        if (file === path || !scope(file) || !named.test(text)) continue;
        for (const { test, chain } of reachers(reverse, tests, file)) {
          if (byImport.has(test) || test === path) continue;
          add(test, { kind: 'fallback', changed: path, chain: [...chain, path] });
          count('fallback', test);
        }
      }
      if (!Object.keys(picked).length && pkg && CODE.test(path)) {
        for (const test of graph.computed) {
          if (!inside(test, pkg.dir) || !tests.has(test)) continue;
          add(test, { kind: 'fallback', changed: path, chain: [test, path], computed: true });
          count('fallback', test);
        }
      }
    }
    if (shared) note = 'a shared root: its importers and the smoke set only; CI runs every suite on the pushed head';
    else if (!Object.keys(picked).length && !note) note = exists ? 'no test imports or names it' : 'deleted; no test names it';
    const kinds = Object.fromEntries(Object.entries(picked).map(([kind, set]) => [kind, set.size]));
    paths.push({ path, kinds, ...(note ? { note } : {}) });
  }
  const warnings = [];
  for (const [name, file] of Object.entries(smoke ?? {})) {
    const set = sets.find((s) => s.name === name);
    if (!set || !set.files.includes(file)) { warnings.push(`SMOKE names ${name} ${file}, which is not one of its test files here; update SMOKE in scripts/test-affected.mjs`); continue; }
    add(set.dir === '.' ? file : `${set.dir}/${file}`, { kind: 'smoke', changed: null, chain: [] });
  }
  const suites = sets.filter((set) => picks.has(set)).map((set) => {
    const mine = picks.get(set);
    const files = [...mine.keys()].sort();
    return { name: set.name, dir: set.dir, files, why: Object.fromEntries(files.map((file) => [file, mine.get(file)])), command: (options) => set.command(files, options) };
  });
  return { suites, paths, warnings };
}

/** A command as one line a shell runs from the root. */
export function shellLine({ argv, env = {}, cwd }) {
  const quote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
  const line = [...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`), ...argv.map(quote)].join(' ');
  return cwd ? `(cd ${quote(cwd)} && ${line})` : line;
}

const git = (root, ...rest) => execFileSync('git', ['-C', root, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The paths changed since the merge base of HEAD and `ref` (committed, staged, unstaged, untracked), and that base. */
export function changedSince(root, ref) {
  const refs = ref ? [ref] : DEFAULT_BASES;
  const found = refs.find((candidate) => { try { git(root, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`); return true; } catch { return false; } });
  if (!found) throw new Usage(`none of ${refs.join(', ')} names a commit; fetch it (git fetch origin) or pass --base <ref>`);
  let base;
  try { base = git(root, 'merge-base', found, 'HEAD').trim(); } catch { throw new Usage(`no merge base of HEAD and ${found}`); }
  const files = [...new Set([
    ...git(root, 'diff', '--name-only', '--no-renames', '-z', base).split('\0'),
    ...git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean))].sort();
  return { base, ref: found, files };
}

function main(args) {
  const root = process.cwd();
  const flags = new Set(['--list', '--json', '--run', '--no-smoke', '--stdin']);
  const valued = new Set(['--base', '--concurrency']);
  const options = {}, given = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) options[arg] = true;
    else if (valued.has(arg)) { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Usage(`${arg} needs a value`); options[arg] = args[++i]; }
    else if (arg.startsWith('--')) throw new Usage(`unknown option ${arg}`);
    else given.push(arg);
  }
  if (['--list', '--json', '--run'].filter((flag) => options[flag]).length > 1) throw new Usage('--list, --json and --run are one at a time');
  if (options['--concurrency'] !== undefined && !/^[1-9]\d*$/.test(options['--concurrency'])) throw new Usage(`--concurrency is a whole number of test files, not "${options['--concurrency']}"`);
  if (options['--base'] && (given.length || options['--stdin'])) throw new Usage('--base reads the changed paths from git; with paths given it has nothing to do');
  if (!existsSync(join(root, 'package.json'))) throw new Usage('run it from the repository root');
  const concurrency = options['--concurrency'] && Number(options['--concurrency']);
  if (options['--stdin']) given.push(...readFileSync(0, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean));
  const normal = (path) => toPosix(relative(root, resolve(root, path)));
  let changed, from;
  if (given.length || options['--stdin']) { changed = [...new Set(given.map(normal))].sort(); from = 'the paths given'; } else {
    const since = changedSince(root, options['--base']);
    changed = since.files;
    from = `${since.base.slice(0, 10)}, the merge base with ${since.ref}`;
  }
  const result = select(root, changed, { smoke: options['--no-smoke'] ? {} : SMOKE });
  for (const warning of result.warnings) console.error(`test-affected: ${warning}`);
  const total = result.suites.reduce((sum, suite) => sum + suite.files.length, 0);
  const summary = `test-affected: ${changed.length} changed path${changed.length === 1 ? '' : 's'} (${from}) pick ${total} test file${total === 1 ? '' : 's'} in ${result.suites.length} suite${result.suites.length === 1 ? '' : 's'}`;
  if (options['--json']) {
    console.log(JSON.stringify({
      base: from, changed, paths: result.paths, warnings: result.warnings,
      suites: Object.fromEntries(result.suites.map((suite) => [suite.name, { dir: suite.dir, command: shellLine(suite.command({ concurrency })), files: suite.files, why: suite.why }])),
    }, null, 2));
    return 0;
  }
  console.error(summary);
  for (const { path, kinds, note } of result.paths) {
    const counts = Object.entries(kinds).map(([kind, n]) => `${n} by ${kind}`);
    console.error(`  ${path}: ${[...counts, ...(note ? [note] : [])].join('; ')}`);
  }
  if (options['--list']) {
    for (const suite of result.suites) for (const file of suite.files) console.log(suite.dir === '.' ? file : `${suite.dir}/${file}`);
    return 0;
  }
  if (!options['--run']) {
    for (const suite of result.suites) console.log(shellLine(suite.command({ concurrency })));
    return 0;
  }
  // Each suite runs as its own: under a `node --test` that started this script, NODE_TEST_CONTEXT would make every
  // command's `node --test` report to that parent instead, and pass having run nothing.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const failed = [];
  for (const suite of result.suites) {
    const command = suite.command({ concurrency });
    console.error(`test-affected: ${suite.name}, ${suite.files.length} file${suite.files.length === 1 ? '' : 's'}: ${shellLine(command)}`);
    const started = Date.now();
    const run = spawnSync(command.argv[0], command.argv.slice(1), { cwd: join(root, command.cwd ?? '.'), stdio: 'inherit', env: { ...env, ...command.env } });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.error(`test-affected: ${suite.name} ${run.status === 0 ? 'passed' : `failed (exit ${run.status ?? run.signal})`} in ${seconds} s`);
    if (run.status !== 0) failed.push(`${suite.name} (exit ${run.status ?? run.signal})`);
  }
  console.error(`test-affected: ${result.suites.length - failed.length} of ${result.suites.length} suites passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  return failed.length ? 1 : 0;
}

if (isMain(import.meta)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    if (!(error instanceof Usage)) throw error;
    console.error(`test-affected: ${error.message}\nusage: node scripts/test-affected.mjs [--base <ref>] [--stdin] [<path>...] [--list | --json | --run] [--concurrency <n>] [--no-smoke]`);
    process.exitCode = 2;
  }
}
