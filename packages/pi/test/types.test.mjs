import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
const flags = ['--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext'];
test('public declarations compile under strict NodeNext without skipLibCheck', () => {
  execFileSync(process.execPath, [tsc, ...flags, fileURLToPath(new URL('./consumer-types.ts', import.meta.url))], { encoding: 'utf8' });
});
test('actual SDK model, runtime and typed custom tool remain assignable', () => {
  // The SDK has unrelated upstream provider declaration errors. This check
  // still strictly checks our fixture's assignments; the public consumer above
  // and packed release consumer do not skip any declaration checking.
  execFileSync(process.execPath, [tsc, ...flags, '--skipLibCheck', fileURLToPath(new URL('./sdk-types.ts', import.meta.url))], { encoding: 'utf8' });
});
