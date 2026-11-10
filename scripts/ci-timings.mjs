// Rewrites scripts/ci-timings.json, the weights scripts/ci-plan.mjs shards by, from CI job logs (GitHub-hosted runners).
//   node scripts/ci-timings.mjs <job log>...
// A log is a job's raw log (`gh api repos/<owner>/<repo>/actions/jobs/<id>/logs`): test shards and pi parts, from runs
// on GitHub's runners (pull requests run every job there). For each suite a log runs, it reads node --test's TAP (each
// top-level test's duration_ms, credited to the file that declares a test of that name) or vitest's per-file lines, and
// the suite's wall time (node --test's closing duration_ms, vitest's Duration); for a pi part, each workspace's
// type-check. It writes the median over the logs of each file's seconds, each suite's file total over its wall time
// (its parallelism), the wall of each suite scripts/ci-shards.json runs whole, and each type-check. A test whose name
// matches no file, or several, is left out: its file keeps its suite's median weight, as a new file does.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';
import { readConfig, readSuites } from './ci-plan.mjs';

const ANSI = /\x1b\[[0-9;]*m/g;
const LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?(.*)$/;

/** The suite a line starts (`npm exec|run test -w <name>`, `npm run <root script>`, `npm exec -c "node --test` at the root), or undefined. */
function started(line, rootSuites) {
  const workspace = /^(?:##\[group\]|\$ )npm (?:run test|exec) -w (\S+)/.exec(line);
  if (workspace) return workspace[1];
  const root = /^(?:##\[group\]|\$ )npm run (\S+)$/.exec(line);
  if (root && rootSuites.includes(root[1])) return root[1];
  // A root suite's files, as ci-shard runs them (`npm exec -c "node --test ..."`, or earlier `node --test ...` for examples).
  const files = /^(?:##\[group\]|\$ )(?:npm exec -c "?)?node --test(?: --test-[a-z]+=\d+)* '?([\w.-]+)\//.exec(line);
  if (files) return rootSuites.find((name) => (name === 'test:examples' ? files[1] === 'examples' : name === 'test:release' && files[1] === 'scripts'));
  return undefined;
}

/** One log's suites: `[{ suite, tests: [[name, seconds]], files: [[file, seconds]], wall }]` and its type-checks `[[name, seconds]]`. */
export function readLog(text, rootSuites) {
  const suites = [];
  const typechecks = [];
  let current;
  let pending;
  let typecheck;
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw.trimEnd());
    if (!match) continue;
    const at = Date.parse(raw.slice(0, raw.indexOf(' ')));
    const line = match[1].replace(ANSI, '');
    if (typecheck && (line.startsWith('$ ') || /^pi \d/.test(line))) { typechecks.push([typecheck.name, (at - typecheck.at) / 1000]); typecheck = undefined; }
    const check = /^\$ npm run typecheck -w (\S+)/.exec(line);
    if (check) typecheck = { name: check[1], at };
    const suite = started(line, rootSuites);
    if (suite || line.startsWith('$ ') || /^pi \d/.test(line) || line.startsWith('##[endgroup]')) {
      current = suite ? { suite, tests: [], files: [], wall: undefined } : undefined;
      if (current) suites.push(current);
      pending = undefined;
      continue;
    }
    if (!current) continue;
    const result = /^(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(line);
    if (result) { pending = result[1]; continue; }
    const duration = /^ {2}duration_ms: ([\d.]+)$/.exec(line);
    if (duration && pending !== undefined) { current.tests.push([pending, Number(duration[1]) / 1000]); pending = undefined; continue; }
    const vitest = /^\s*[✓×❯↓]\s+(test\/\S+\.test\.ts)\s+\(\d+ tests?[^)]*\)\s*(\d+)ms/.exec(line);
    if (vitest) { current.files.push([vitest[1], Number(vitest[2]) / 1000]); continue; }
    const tapWall = /^# duration_ms ([\d.]+)$/.exec(line);
    if (tapWall) current.wall = Number(tapWall[1]) / 1000;
    const vitestWall = /^\s*Duration\s+([\d.]+)(m?s)\b/.exec(line);
    if (vitestWall) current.wall = Number(vitestWall[1]) / (vitestWall[2] === 'ms' ? 1000 : 1);
  }
  return { suites, typechecks };
}

const unescape = (text) => text.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
// A call on a value (`/re/.test(...)`, `t.test(...)`) declares no top-level test: read as one, a template's pattern could
// match every name and leave every test of its suite uncredited.
const DECLARED = /(?<![.\w$])(?:test|it|describe|suite)(?:\.(?:skip|only|todo))?\s*\(\s*(?:(['"])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^`\\])*)`)/g;

/** The top-level test names each file of a suite declares, as exact names and as patterns for template strings. */
export function declaredNames(root, suite) {
  return suite.files.map((file) => {
    const source = readFileSync(join(root, suite.cwd, file), 'utf8');
    const names = [];
    for (const m of source.matchAll(DECLARED)) {
      if (m[3] === undefined) names.push({ exact: unescape(m[2]) });
      else names.push({ pattern: new RegExp(`^${m[3].split(/\$\{[^}]*\}/).map((part) => unescape(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^]*')}$`) });
    }
    return { file, names };
  });
}

/** The one file of `declared` that declares a test called `name` (TAP's escapes undone), or undefined. */
export function fileOf(declared, name) {
  const plain = name.replace(/\\#/g, '#').replace(/\\\\/g, '\\');
  const hits = declared.filter(({ names }) => names.some((n) => (n.exact !== undefined ? n.exact === plain : n.pattern.test(plain))));
  return hits.length === 1 ? hits[0].file : undefined;
}

const median = (values) => { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const tenths = (value) => Math.round(value * 10) / 10;

/** The timings, from the logs' texts, for the suites under `root`. */
export function timingsOf(root, texts, { config } = readConfig(root)) {
  const suites = new Map(readSuites(root, { config }).map((suite) => [suite.name, suite]));
  const declared = new Map();
  const files = new Map();
  const parallelism = new Map();
  const walls = new Map();
  const typecheck = new Map();
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const text of texts) {
    const log = readLog(text, config.rootSuites ?? []);
    for (const [name, seconds] of log.typechecks) push(typecheck, name, seconds);
    for (const run of log.suites) {
      const suite = suites.get(run.suite);
      if (!suite) continue;
      if (!declared.has(suite.name) && !suite.whole) declared.set(suite.name, declaredNames(root, suite));
      const perFile = new Map();
      let total = 0;
      for (const [file, seconds] of run.files) { perFile.set(file, (perFile.get(file) ?? 0) + seconds); total += seconds; }
      for (const [name, seconds] of run.tests) {
        total += seconds;
        const file = suite.whole ? undefined : fileOf(declared.get(suite.name), name);
        if (file) perFile.set(file, (perFile.get(file) ?? 0) + seconds);
      }
      for (const [file, seconds] of perFile) if (suite.files.includes(file)) push(files, suite.cwd === '.' ? file : `${suite.cwd}/${file}`, seconds);
      if (run.wall > 1) {
        if (total > 0) push(parallelism, suite.name, total / run.wall);
        if (suite.whole) push(walls, suite.name, run.wall);
      }
    }
  }
  const out = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, values]) => [key, tenths(median(values))]));
  return { parallelism: out(parallelism), walls: out(walls), typecheck: out(typecheck), files: out(files) };
}

if (isMain(import.meta)) {
  const logs = process.argv.slice(2);
  if (!logs.length) { console.error('usage: node scripts/ci-timings.mjs <job log>...'); process.exit(2); }
  const root = process.cwd();
  const timings = timingsOf(root, logs.map((path) => readFileSync(path, 'utf8')));
  const about = 'Seconds on a GitHub-hosted runner, medians over CI job logs, written by scripts/ci-timings.mjs: files, each test file\'s own time; parallelism, a suite\'s file total over its wall time; walls, a suite run as a whole; typecheck, a workspace\'s type-check in a pi part.';
  writeFileSync(join(root, 'scripts', 'ci-timings.json'), `${JSON.stringify({ about, ...timings }, null, 1)}\n`);
  console.log(`scripts/ci-timings.json: ${Object.keys(timings.files).length} files, ${Object.keys(timings.parallelism).length} suites, ${Object.keys(timings.typecheck).length} type-checks, from ${logs.length} logs`);
}
