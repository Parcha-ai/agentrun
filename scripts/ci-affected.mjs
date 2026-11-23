// The tests a pull request's CI runs in a pool scripts/ci-shards.json marks `"affected": true`: those its changes reach
// (scripts/test-affected.mjs), or every test where that cannot be trusted. ci-shard reads it when CI_AFFECTED_BASE names a
// commit: on a pull request ci.yml sets HEAD^1, the merge commit's first parent, so the changes are what the pull request
// adds to the base it was merged with. The merge queue and main run every test, so a test this misses fails there.
// - Every test runs when the diff cannot be read, or when a changed path is a shared root (SHARED_ROOTS in
//   test-affected.mjs: the root manifests, the lockfile, tsconfig.base.json, .nvmrc, .npmrc, scripts/, .github/) and not
//   itself a test file: every suite may read one, and no import says which.
// - Otherwise the tests test-affected picks (a changed test, its importers, a package's config, a file a test names, the
//   smoke set), and every test of a package with a changed file that picks none, unless it is Markdown or was deleted: a
//   Go source, a SQL migration or a fixture read by listing its folder reaches tests that no import or name shows. A
//   deleted file no test names is one no test imports. A suite CI runs whole (pi-browser's) runs for a pick of its own,
//   not for its smoke file: whole, it is no fast check.
// Every shard job of a run computes the same selection from the same checkout, and plans it the same way.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_ROOTS, SMOKE, readPackages, readTestSets, select } from './test-affected.mjs';

const MARKDOWN = /\.md$/i;
const inside = (path, dir) => path.startsWith(`${dir}/`);

/** The paths that differ between the commit `base` names and HEAD, sorted; throws when either cannot be read. */
export function changedPaths(root, base) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { git('rev-parse', '--verify', '--quiet', `${base}^{commit}`); } catch { throw new Error(`${base} names no commit in this checkout`); }
  return [...new Set(git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean))].sort();
}

/**
 * What `changed` runs: `{ full }`, why every test runs, or `{ files, suites, paths, warnings }`: `files` the picked test
 * files from the root, `suites` the suites with one (a whole suite runs when it has one), `paths` each changed path with
 * what it picked (test-affected's `{ path, kinds, note }`, and `widened` where its package's every test was added).
 */
export function affectedTests(root, changed, { sets = readTestSets(root), packages = readPackages(root), smoke = SMOKE } = {}) {
  const testPaths = new Set(sets.flatMap((set) => set.files.map((file) => (set.dir === '.' ? file : `${set.dir}/${file}`))));
  const shared = changed.find((path) => !testPaths.has(path) && SHARED_ROOTS.some((re) => re.test(path)));
  if (shared) return { full: `${shared} is a shared root, which any suite may read` };
  const result = select(root, changed, { sets, packages, smoke });
  const files = new Set(), suites = new Set();
  const take = (set, file) => { files.add(set.dir === '.' ? file : `${set.dir}/${file}`); suites.add(set.name); };
  for (const suite of result.suites) {
    const set = sets.find((candidate) => candidate.name === suite.name);
    for (const file of suite.files) if (!set.whole || suite.why[file].some((reason) => reason.kind !== 'smoke')) take(set, file);
  }
  const paths = result.paths.map((entry) => {
    if (Object.keys(entry.kinds).length || MARKDOWN.test(entry.path) || !existsSync(join(root, entry.path))) return entry;
    const pkg = packages.filter((candidate) => inside(entry.path, candidate.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
    const set = pkg && sets.find((candidate) => candidate.dir === pkg.dir);
    if (!set) return entry;
    for (const file of set.files) take(set, file);
    return { ...entry, widened: `every test of ${set.name}: no import or name reaches it` };
  });
  return { files, suites, paths, warnings: result.warnings };
}

/** The selection for the changes since `base`: affectedTests' result with `base` and `changed`, or `{ full }` when git cannot say. */
export function affectedSince(root, base, options) {
  let changed;
  try { changed = changedPaths(root, base); } catch (error) {
    const why = (error.stderr?.toString().trim() || error.message).split('\n')[0];
    return { base, full: `the paths changed since ${base} cannot be read: ${why}` };
  }
  return { base, changed, ...affectedTests(root, changed, options) };
}
