// The workspaces' build: TypeScript's build mode (project references, incremental) in one process, so a package compiles
// once, after the packages it references, and only when its inputs changed.
//   node scripts/build.mjs [--typecheck] [--verbose] [<directory or tsconfig>...]
// A directory selects every workspace inside it (the default is the repository: all of them). The build compiles each
// selected workspace's emitting tsconfig and those it references; --typecheck also checks every other tsconfig in those
// workspaces (tests, type tests, examples), plus any tsconfig named on the command line.
// Around a workspace's compile it runs that workspace's `build:before` and `build:after` scripts, if it has them.
// What tsc's build mode leaves to this script:
//   - buildinfo lives in node_modules/.cache/agentrun-build/<hash of what npm installed>, so a new install (another
//     dependency version: a change tsc does not look for) starts every project from scratch;
//   - an emitting project whose outDir lacks an output of its sources, or holds declarations whose source is gone, is
//     emptied and compiled whole, so a deleted or renamed source never leaves a stale module in dist;
//   - a program that reads another project's output must reference that project, or tsc would not rebuild it when that
//     project changes: the build fails naming the reference to add.
// A workspace whose emitting tsconfig is not composite cannot be referenced (a synced or vendored copy keeps the tsconfig
// of its upstream). It builds with its own `build` script, after the workspaces it depends on (package.json), and only
// when its sources, its tsconfigs, its package.json or the declarations of those workspaces changed, or its outDir did.
// A program that reads its declarations compiles whole when they change, since tsc's build mode does not look at them.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(join(repository, 'package.json'))('typescript');
const slashed = (path) => path.split(sep).join('/');
const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The workspace directories the root package.json names (`dir` or `dir/*`), sorted. */
export function workspaces(rootDir = repository) {
  const globs = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).workspaces ?? [];
  return globs.flatMap((glob) => {
    if (!glob.endsWith('/*')) return [resolve(rootDir, glob)];
    const parent = resolve(rootDir, glob.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
  }).filter((dir) => existsSync(join(dir, 'package.json'))).sort();
}

/** Every tsconfig*.json under `dir`, outside node_modules, dist and dot-directories. */
export function tsconfigsIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.') ? [] : tsconfigsIn(join(dir, e.name));
    return /^tsconfig(\..+)?\.json$/.test(e.name) ? [join(dir, e.name)] : [];
  });
}

/** The hash of what npm installed (its record in node_modules, else the lockfile): buildinfo is kept per install. */
function installHash(root) {
  const record = [join(root, 'node_modules', '.package-lock.json'), join(root, 'package-lock.json')].find(existsSync);
  return createHash('sha256').update(record ? readFileSync(record) : '').update(ts.version).digest('hex').slice(0, 16);
}

const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

/** Why an emitting project's outDir does not match its sources, or undefined when it does. Before a compile, an output
 *  counts as missing only if its source is no newer than the buildinfo (a source added or changed since is compiled
 *  anyway); after it, every source's outputs must be there. */
export function staleOutputs(parsed, { compiled = false, rel = slashed } = {}) {
  const outDir = parsed.options.outDir;
  if (!outDir) return undefined;
  const ignoreCase = !ts.sys.useCaseSensitiveFileNames;
  const builtAt = compiled ? Infinity : existsSync(parsed.options.tsBuildInfoFile) ? statSync(parsed.options.tsBuildInfoFile).mtimeMs : -Infinity;
  const expected = new Set();
  for (const source of parsed.fileNames) {
    const outputs = ts.getOutputFileNames(parsed, source, ignoreCase).map((file) => resolve(file));
    for (const file of outputs) expected.add(file);
    const missing = statSync(source).mtimeMs <= builtAt && outputs.find((file) => !existsSync(file));
    if (missing) return `${rel(missing)} is missing`;
  }
  const orphan = (existsSync(outDir) ? filesUnder(outDir) : []).find((file) => /\.d\.[cm]?ts$/.test(file) && !expected.has(file));
  return orphan && `${rel(orphan)} has no source any more`;
}

/** Runs a workspace's `build:before` or `build:after` script, as npm would (its folder, node_modules/.bin on PATH). */
function runStep(root, workspace, name, rel) {
  const script = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).scripts?.[name];
  if (!script) return;
  const PATH = [join(workspace, 'node_modules', '.bin'), join(root, 'node_modules', '.bin'), process.env.PATH].join(delimiter);
  const done = spawnSync(script, { cwd: workspace, shell: true, stdio: 'inherit', env: { ...process.env, PATH } });
  if (done.status !== 0) throw new Error(`${rel(workspace)}: ${name} (${script}) exited ${done.status ?? done.signal}`);
}

export function build({ root = repository, targets = [root], typecheck = false, verbose = false, log = (line) => console.log(line) } = {}) {
  const started = performance.now();
  const rel = (path) => slashed(relative(root, path)) || '.';
  const all = workspaces(root);
  const workspaceOf = (path) => all.find((dir) => inside(dir, path) && !inside(join(dir, 'node_modules'), path));
  const cache = join(root, 'node_modules', '.cache', 'agentrun-build');
  const hash = installHash(root);
  for (const old of existsSync(cache) ? readdirSync(cache) : []) if (old !== hash) rmSync(join(cache, old), { recursive: true, force: true });

  const formatHost = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' };
  const parseHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } };
  const extendedConfigCache = new Map();
  const parsedCache = new Map();
  const parse = (file) => {
    file = resolve(file);
    if (!parsedCache.has(file)) {
      const parsed = ts.getParsedCommandLineOfConfigFile(file, undefined, parseHost, extendedConfigCache);
      if (parsed?.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, formatHost));
      parsed.options.tsBuildInfoFile = join(cache, hash, `${rel(file).replace(/\.json$/, '')}.tsbuildinfo`);
      if (parsed.options.noEmit) parsed.options.incremental = true;
      parsedCache.set(file, parsed);
    }
    return parsedCache.get(file);
  };
  const emits = (file) => !parse(file).options.noEmit;
  const references = (file) => (parse(file).projectReferences ?? []).map((ref) => resolve(ts.resolveProjectReferencePath(ref)));

  // Every workspace's emitting project, by outDir: what a program may read only through a reference. A tsconfig that does
  // not parse here fails the run only if the run builds or checks it.
  const outDirs = all.flatMap(tsconfigsIn).flatMap((file) => {
    try { return emits(file) && parse(file).options.outDir ? [[parse(file).options.outDir, file]] : []; } catch { return []; }
  });
  const emittersIn = (dir) => tsconfigsIn(dir).filter((file) => outDirs.some(([, owner]) => owner === file));
  const outputDirs = (dir) => emittersIn(dir).map((file) => parse(file).options.outDir);
  const externals = new Set(all.filter((dir) => emittersIn(dir).some((file) => !parse(file).options.composite)));

  // What each workspace depends on, from its package.json, transitively.
  const manifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const byName = new Map(all.map((dir) => [manifest(dir).name, dir]));
  const dependencies = (dir, seen = new Set()) => {
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].map((field) => manifest(dir)[field] ?? {});
    for (const dep of fields.flatMap(Object.keys).map((name) => byName.get(name))) {
      if (dep && dep !== dir && !seen.has(dep)) dependencies(dep, seen.add(dep));
    }
    return seen;
  };
  const dependedOn = (dir) => [...dependencies(dir)].sort();

  const hashOf = (files) => {
    const digest = createHash('sha256');
    for (const file of [...files].map((file) => resolve(file)).sort()) digest.update(rel(file)).update('\0').update(readFileSync(file)).update('\0');
    return digest.digest('hex');
  };
  const outputFiles = (dir, keep = () => true) => outputDirs(dir).flatMap((out) => (existsSync(out) ? filesUnder(out) : [])).filter(keep);
  const declarationStamps = new Map();
  const declarationsOf = (dir) => {
    if (!declarationStamps.has(dir)) declarationStamps.set(dir, existsSync(dir) ? hashOf(outputFiles(dir, (file) => /\.d\.[cm]?ts$/.test(file))) : 'gone');
    return declarationStamps.get(dir);
  };
  const readRecord = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
  const writeRecord = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value)}\n`); };
  const externalsRecord = (config) => parse(config).options.tsBuildInfoFile.replace(/\.tsbuildinfo$/, '.externals.json');

  const roots = targets.flatMap((target) => {
    target = resolve(target);
    if (statSync(target).isFile()) return [target];
    return all.filter((dir) => inside(target, dir)).flatMap((dir) => {
      if (externals.has(dir)) return [dir];
      const configs = tsconfigsIn(dir);
      return typecheck ? configs : configs.filter(emits);
    });
  });
  if (!roots.length) throw new Error(`no workspace tsconfig under ${targets.join(', ')}`);

  // Build order: each project after the projects it references, and after the workspaces outside the references that its
  // workspace depends on (all of them, for a tsconfig outside the workspaces); such a workspace after its dependencies.
  const edges = (node) => {
    if (externals.has(node)) return dependedOn(node).flatMap((dep) => (externals.has(dep) ? [dep] : emittersIn(dep)));
    const workspace = workspaceOf(node);
    return [...references(node), ...(workspace ? dependedOn(workspace) : all).filter((dir) => externals.has(dir))];
  };
  const order = [];
  const state = new Map();
  const visit = (node, path) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') throw new Error(`the build order forms a cycle: ${[...path, node].map(rel).join(' -> ')}`);
    state.set(node, 'visiting');
    for (const next of edges(node)) visit(next, [...path, node]);
    state.set(node, 'done');
    order.push(node);
  };
  for (const node of roots) visit(node, []);

  const unreferenced = new Map();
  const compiled = new Set();
  const createProgram = (rootNames, options, host, oldProgram, diagnostics, projectReferences) => {
    const program = ts.createEmitAndSemanticDiagnosticsBuilderProgram(rootNames, options, host, oldProgram, diagnostics, projectReferences);
    const config = resolve(options.configFilePath);
    const refs = new Set((projectReferences ?? []).map((ref) => resolve(ts.resolveProjectReferencePath(ref))));
    const own = new Set(rootNames.map((file) => resolve(file)));
    const missing = { refs: new Set(), files: new Set() };
    const read = new Set();
    for (const { fileName } of program.getProgram().getSourceFiles()) {
      const file = resolve(fileName);
      if (own.has(file) || file.split(sep).includes('node_modules')) continue;
      const owner = outDirs.find(([dir]) => inside(dir, file))?.[1];
      if (!owner) missing.files.add(file);
      else if (externals.has(workspaceOf(owner))) read.add(file);
      else if (owner !== config && !refs.has(owner)) missing.refs.add(owner);
    }
    writeRecord(externalsRecord(config), Object.fromEntries([...read].sort().map((file) => [rel(file), hashOf([file])])));
    if (missing.refs.size || missing.files.size) unreferenced.set(config, missing);
    compiled.add(config);
    return program;
  };
  const pretty = !!process.stdout.isTTY;
  const host = ts.createSolutionBuilderHost(ts.sys, createProgram, ts.createDiagnosticReporter(ts.sys, pretty), ts.createBuilderStatusReporter(ts.sys, pretty));
  host.getParsedCommandLine = (file) => parse(file);
  const builder = ts.createSolutionBuilder(host, order.filter((node) => !externals.has(node)), { verbose });

  // A workspace outside the references: its own build, skipped while what it was built from and what it built are unchanged.
  const buildExternal = (dir) => {
    const record = join(cache, hash, rel(dir), 'build.json');
    const sources = new Set([join(dir, 'package.json')]);
    for (const config of emittersIn(dir)) {
      const { options, fileNames } = parse(config);
      for (const file of [config, ...(options.configFile?.extendedSourceFiles ?? []), ...fileNames]) sources.add(resolve(file));
      if (options.rootDir && existsSync(options.rootDir)) for (const file of filesUnder(options.rootDir)) sources.add(file);
    }
    const inputs = createHash('sha256').update(hashOf(sources));
    for (const dep of dependedOn(dir)) inputs.update(`${rel(dep)}\0${declarationsOf(dep)}\0`);
    const built = { inputs: inputs.digest('hex'), outputs: hashOf(outputFiles(dir)) };
    const prior = readRecord(record);
    if (prior?.inputs === built.inputs && prior.outputs === built.outputs) return;
    if (!manifest(dir).scripts?.build) throw new Error(`${rel(dir)}: its tsconfig is not composite, so it builds with its own "build" script, and it has none`);
    const at = performance.now();
    rmSync(record, { force: true });
    runStep(root, dir, 'build', rel);
    declarationStamps.delete(dir);
    writeRecord(record, { ...built, outputs: hashOf(outputFiles(dir)) });
    compiled.add(dir);
    log(`built ${rel(dir)} in ${((performance.now() - at) / 1000).toFixed(1)} s`);
  };

  for (const config of order) {
    if (externals.has(config)) {
      buildExternal(config);
      continue;
    }
    const workspace = workspaceOf(config);
    // tsc's build mode does not look at the declarations a program reads from outside its references.
    const buildinfo = parse(config).options.tsBuildInfoFile;
    if (existsSync(buildinfo)) {
      const read = readRecord(externalsRecord(config));
      const changed = read && Object.keys(read).find((file) => !existsSync(resolve(root, file)) || hashOf([resolve(root, file)]) !== read[file]);
      if (!read || changed) {
        log(`${rel(config)}: ${read ? `${changed} changed` : 'no record of what it reads outside its references'}; compiling it whole`);
        rmSync(buildinfo, { force: true });
      }
    }
    const parsed = parse(config);
    const emitting = !parsed.options.noEmit;
    if (emitting && workspace) {
      runStep(root, workspace, 'build:before', rel);
      parsedCache.delete(config);
    }
    const project = parse(config);
    const stale = emitting && staleOutputs(project, { rel });
    if (stale) {
      log(`${rel(config)}: ${stale}; compiling it whole`);
      rmSync(project.options.outDir, { recursive: true, force: true });
      rmSync(project.options.tsBuildInfoFile, { force: true });
    }
    const at = performance.now();
    const status = builder.build(config);
    declarationStamps.delete(workspace);
    if (status !== ts.ExitStatus.Success) throw Object.assign(new Error(`${rel(config)}: TypeScript reported errors`), { quiet: true });
    // A check-only program that found nothing changed does not write its buildinfo, so a reference compiled since would
    // keep it out of date on every run: it was checked against the current inputs just now.
    if (!emitting && compiled.has(config) && existsSync(buildinfo)) utimesSync(buildinfo, new Date(), new Date());
    // Left only by a source whose time changed but not its text, after its output was deleted: tsc then emits nothing.
    const missing = emitting && staleOutputs(project, { compiled: true, rel });
    if (missing) {
      rmSync(project.options.tsBuildInfoFile, { force: true });
      throw new Error(`${rel(config)}: ${missing} after its compile; run the build again to compile it whole`);
    }
    if (compiled.has(config)) log(`${emitting ? 'built' : 'checked'} ${rel(config)} in ${((performance.now() - at) / 1000).toFixed(1)} s`);
    if (emitting && workspace) runStep(root, workspace, 'build:after', rel);
  }
  // A missing reference leaves the build right but its next incremental run blind to that project: the program's buildinfo
  // goes, so the next run compiles it again and repeats this until the reference is there.
  if (unreferenced.size) {
    for (const config of unreferenced.keys()) rmSync(parse(config).options.tsBuildInfoFile, { force: true });
    throw new Error([...unreferenced].flatMap(([config, missing]) => {
      const refs = [...missing.refs], files = [...missing.files];
      return [
        ...(refs.length ? [`${rel(config)} reads the output of ${refs.map(rel).join(', ')} without referencing it, so a change there would not rebuild it: add ${refs.map((ref) => `{ "path": "${slashed(relative(dirname(config), ref))}" }`).join(', ')} to its "references"`] : []),
        ...(files.length ? [`${rel(config)} reads ${files.slice(0, 5).map(rel).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}, which it neither includes nor gets from a project it references, so a change there would not rebuild it: include them, or reference the project that builds them`] : []),
      ];
    }).join('\n'));
  }
  log(`${order.length} projects: ${compiled.size} compiled, ${order.length - compiled.size} current (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const targets = args.filter((arg) => !arg.startsWith('--'));
  try {
    const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--typecheck' && arg !== '--verbose');
    if (unknown.length) throw new Error(`unknown option ${unknown.join(', ')}: usage: node scripts/build.mjs [--typecheck] [--verbose] [<directory or tsconfig>...]`);
    build({ targets: targets.length ? targets : [repository], typecheck: args.includes('--typecheck'), verbose: args.includes('--verbose') });
  } catch (error) {
    if (!error.quiet) console.error(error.message);
    process.exitCode = 1;
  }
}
