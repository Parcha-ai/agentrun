// Every durable document definition in packages/*/src names its checkpointWhen. pi-durable 1.4 and later require it on
// each defineDoc/defineDocFamily; on 1.1 it is optional, and leaving it out keeps every ordinary change a delta commit
// (1.1 checkpoints only on a truthy checkpointWhen), which is what `checkpointWhen: () => false` says. Read from each
// call's object literal (TypeScript's parser), so a definition spread over lines, or built from a shared object, is
// judged by what the call is given.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = execFileSync('git', ['-c', 'gc.auto=0', 'ls-files', 'packages/*/src/*.ts', 'packages/*/src/**/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));

/** Each defineDoc/defineDocFamily call in `file`: its line, and whether its options name checkpointWhen. An options
 *  argument that is not an object literal (a variable) counts as not naming it: the guard cannot see inside it. */
function definitions(file) {
  const text = readFileSync(join(root, file), 'utf8');
  if (!/defineDoc(?:Family)?\b/.test(text)) return [];
  const unit = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'defineDoc' || node.expression.text === 'defineDocFamily')) {
      const options = node.arguments[0];
      const names = options && ts.isObjectLiteralExpression(options) ? options.properties.map((property) => property.name && ts.isIdentifier(property.name) ? property.name.text : property.name && ts.isStringLiteral(property.name) ? property.name.text : undefined) : [];
      found.push({ line: unit.getLineAndCharacterOfPosition(node.getStart()).line + 1, named: names.includes('checkpointWhen') });
    }
    ts.forEachChild(node, visit);
  };
  visit(unit);
  return found;
}

test('every defineDoc and defineDocFamily in packages/*/src sets checkpointWhen', () => {
  const all = sources.flatMap((file) => definitions(file).map((definition) => ({ file, ...definition })));
  assert.ok(all.length >= 20, `the guard finds the definitions (${all.length})`);
  const missing = all.filter((definition) => !definition.named).map(({ file, line }) => `${file}:${line}`);
  assert.deepEqual(missing, [], 'add checkpointWhen (`() => false` keeps every change a delta, as without it on 1.1)');
});
