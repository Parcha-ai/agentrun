// Which workspace packages a package may not reach. The harness seam (@parcha/agentrun-adapters and each harness package
// beside it) is host-neutral: a DSL host imports it without serve, so it may not depend on or import a host (serve, the
// reference harness) or the Pi runtime. Read from each package's manifest and from every module specifier in its source.
// `node scripts/check-package-imports.mjs` exits non-zero with the problems; the tests run it on this tree and on planted
// breaks.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specifiersOf } from './upstream-attribution.mjs';

/** Package directory pattern, and the package names (or subpaths) its manifest and source may not name. */
export const FORBIDDEN = [
  { packages: /^run-adapters(?:-[a-z0-9-]+)?$/, names: ['@parcha/agentrun-serve', '@parcha/agentrun-harness', '@parcha/pi-durable-agent/serve', '@parcha/agentrun-pi'] },
];

const reaches = (specifier, name) => specifier === name || specifier.startsWith(`${name}/`);

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'dist'].includes(entry.name)) out.push(...await sourceFiles(path)); }
    else if (/\.(?:[cm]?[jt]s|tsx?)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Problems in the workspace at `root`; empty passes. */
export async function packageImportProblems(root) {
  const problems = [];
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rules = FORBIDDEN.filter((rule) => rule.packages.test(entry.name));
    if (!rules.length) continue;
    const dir = join(root, 'packages', entry.name);
    const names = rules.flatMap((rule) => rule.names);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        for (const name of names) if (reaches(name, dependency)) problems.push(`packages/${entry.name}/package.json ${field} names ${dependency}`);
      }
    }
    for (const file of await sourceFiles(dir)) {
      for (const specifier of specifiersOf(await readFile(file, 'utf8'))) {
        for (const name of names) if (reaches(specifier, name)) problems.push(`${relative(root, file)} imports ${specifier}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await packageImportProblems(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log('Package imports: the harness seam reaches no host.');
}
