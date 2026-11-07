// TypeBox comes from typebox, never through a pi package. pi-ai 1.5 drops its re-export of TypeBox (`Type`, `Static`,
// `TSchema`), as do pi-agent-core, pi-durable and chord: a package that takes them from one of those breaks on the next
// pi family. So no tracked source, test, fixture or example imports them from there, each package whose source uses
// TypeBox declares typebox itself (in `dependencies`, or as a host-provided peer with a dev pin) at the version pi-ai
// resolves, and the tool schemas they build are the same JSON as before the move (tool argument semantics unchanged).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tracked = execFileSync('git', ['-c', 'gc.auto=0', 'ls-files', '*.ts', '*.mts', '*.mjs', '*.tsx', '*.js'], { cwd: root, encoding: 'utf8' }).split('\n').filter((file) => file && !file.startsWith('.release/') && !file.includes('/node_modules/'));
const PI = /^@earendil-works\/(?:pi-ai|pi-agent-core|pi-durable|chord)(?:\/.*)?$/;
const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const TYPEBOX_NAMES = new Set(['Type', 'Static', 'TSchema']);

test('no tracked file imports Type, Static or TSchema from pi-ai, pi-agent-core, pi-durable or chord', () => {
  const found = [];
  for (const file of tracked) {
    let source;
    try { source = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const [, , names, from] of source.matchAll(IMPORT)) {
      if (!PI.test(from)) continue;
      const taken = names.split(',').map((name) => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter((name) => TYPEBOX_NAMES.has(name));
      if (taken.length) found.push(`${file}: ${taken.join(', ')} from ${from}`);
    }
  }
  assert.deepEqual(found, [], 'take TypeBox from typebox');
});

test('each package whose source uses TypeBox declares typebox itself, at the version pi-ai resolves', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const piAi = lock.packages['node_modules/@earendil-works/pi-ai'];
  const wanted = piAi.dependencies.typebox;
  assert.match(wanted, /^\d+\.\d+\.\d+$/, 'pi-ai pins its typebox exactly');
  const wrong = [];
  for (const name of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', name, 'src');
    if (!existsSync(src)) continue;
    const uses = tracked.some((file) => file.startsWith(`packages/${name}/src/`) && /from\s*["']typebox["']/.test(readFileSync(join(root, file), 'utf8')));
    if (!uses) continue;
    const manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
    const declared = manifest.dependencies?.typebox ?? (manifest.peerDependencies?.typebox && manifest.devDependencies?.typebox);
    if (declared !== wanted) wrong.push(`${name}: ${declared ?? 'not declared'}`);
  }
  assert.deepEqual(wrong, [], `typebox ${wanted} in dependencies, or a host-provided peer with a ${wanted} dev pin`);
});

test('the TypeBox-built tool schemas of pi, pi-transport and harness serialize to the same JSON as before the move', async () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/typebox-tool-schemas.json', import.meta.url), 'utf8'));
  const pi = await import('../packages/pi/dist/workflow-tool.js');
  const transport = await import('../packages/pi-transport/dist/config.js');
  const { codeModeExtension } = await import('../packages/harness/dist/code-mode.js');
  const declared = () => ({ signature: 'f()', description: 'd' });
  const now = {
    pi: pi.workflowToolParameters(),
    'pi-transport': transport.TransportConfigSchema,
    harness: codeModeExtension({ see: declared, judge: declared, transcribe: declared }).tools[0].parameters,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(now)), before);
});
