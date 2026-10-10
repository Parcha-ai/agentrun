// What a built entry of a package reaches: every bare specifier in it and in the files it imports. Relative imports
// are followed, and so is the package's own name, through its `exports` map, so an entry cannot hide what it reaches
// behind a self-reference. Other packages are named, never entered.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const IMPORT = /(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g;

/** The bare specifiers reachable from `entry`, a path inside the package at `packageRoot`. A declaration file is
 *  walked as declarations: a relative `./x.js` names `./x.d.ts`, and a self-reference takes its `types` target. A
 *  self-reference the package does not export throws. */
export function reachableImports(packageRoot, entry) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const declarations = entry.endsWith('.d.ts');
  const seen = new Set(), bare = new Set();
  const ownTarget = specifier => {
    const target = manifest.exports?.[`.${specifier.slice(manifest.name.length)}`];
    const file = typeof target === 'string' ? target : target?.[declarations ? 'types' : 'import'];
    if (!file) throw new Error(`${specifier} is not an export of ${manifest.name}`);
    return join(packageRoot, file);
  };
  const visit = file => {
    if (seen.has(file) || !/\.(?:js|d\.ts)$/.test(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), declarations ? specifier.replace(/\.js$/, '.d.ts') : specifier));
      else if (specifier === manifest.name || specifier.startsWith(`${manifest.name}/`)) visit(ownTarget(specifier));
      else bare.add(specifier);
    }
  };
  visit(join(packageRoot, entry));
  return [...bare].sort();
}
