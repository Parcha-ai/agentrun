// Refuses a GitHub workflow with a key twice in one map (two `env:` under a job, say), or one that does not parse. YAML
// loaders differ on a duplicate key (GitHub's keeps one of them, without a word), so the other is lost silently.
//   node scripts/check-workflows.mjs [directory]    (default: .github/workflows)
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

/** What is wrong with a workflow's text, as `<file>:<line>:<column>: <why>`; empty when nothing is. */
export function workflowProblems(text, file) {
  return parseDocument(text).errors.map((error) => {
    const at = error.linePos?.[0];
    const where = at ? `${file}:${at.line}:${at.col}` : file;
    if (error.code === 'DUPLICATE_KEY') {
      const key = /^\s*([^:\s]+)\s*:/.exec(text.split('\n')[(at?.line ?? 1) - 1]?.slice((at?.col ?? 1) - 1) ?? '')?.[1] ?? 'a key';
      return `${where}: the key ${key} appears twice in one map`;
    }
    return `${where}: ${error.message.split('\n')[0]}`;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const dir = resolve(process.argv[2] ?? join(root, '.github', 'workflows'));
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  const problems = files.flatMap((name) => workflowProblems(readFileSync(join(dir, name), 'utf8'), relative(process.cwd(), join(dir, name)) || name));
  if (problems.length) {
    console.error(`workflows: ${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`workflows checked: ${files.length} files, no duplicate key`);
}
