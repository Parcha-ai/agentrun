import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The skill's language reference is the SDK author's contract, rendered from the built package.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'packages/dsl/skills/author/references/language.md');
const { authorContract } = await import(new URL('../packages/dsl/dist/author.js', import.meta.url).href);
const bytes = `<!-- Generated from packages/dsl/src/author.ts by node scripts/generate-author-contract.mjs. Do not edit. -->\n\n# AgentRun workflow language\n\n${authorContract()}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8').catch(() => '') !== bytes) throw new Error('Author language reference is stale; run npm run build && node scripts/generate-author-contract.mjs');
  console.log('Author language reference matches source');
} else {
  await writeFile(output, bytes);
  console.log('Generated packages/dsl/skills/author/references/language.md');
}
