#!/usr/bin/env node
// The Pi author skill must be self-contained (a host without file tools reads only the packaged
// skill), so the shared author contract and the Jev decision guide are copied into its references
// from the dsl package's authoring assets. The copies are generated; check-generated keeps them
// current. Run after editing packages/dsl/authoring/*.md.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const copies = [
  ['packages/dsl/authoring/contract.md', 'packages/pi/skills/author/references/dsl-contract.md'],
  ['packages/dsl/authoring/jev-decisions.md', 'packages/pi/skills/author/references/jev-decisions.md'],
];
for (const [from, to] of copies) {
  const source = await readFile(resolve(root, from), 'utf8');
  const banner = `<!-- Generated from ${from} by scripts/generate-author-references.mjs. Edit the source, not this copy. -->\n\n`;
  await writeFile(resolve(root, to), banner + source);
  console.log(`${to} <- ${from}`);
}
