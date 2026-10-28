// The harness seam reaches no host: this tree passes, and a planted import or dependency of serve goes red.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageImportProblems } from './check-package-imports.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'agentrun-package-imports-'));
after(() => rm(scratch, { recursive: true, force: true }));

test('the harness seam in this tree imports no host', async () => {
  assert.deepEqual(await packageImportProblems(root), []);
});

test('a planted host import or dependency goes red, in the seam and in a harness package beside it', async () => {
  let made = 0;
  const workspace = async (plant) => {
    const dir = join(scratch, `w${made += 1}`);
    await mkdir(join(dir, 'packages'), { recursive: true });
    await cp(join(root, 'packages', 'run-adapters', 'src'), join(dir, 'packages', 'run-adapters', 'src'), { recursive: true });
    await cp(join(root, 'packages', 'run-adapters', 'package.json'), join(dir, 'packages', 'run-adapters', 'package.json'));
    await plant(dir);
    return dir;
  };
  assert.deepEqual(await packageImportProblems(await workspace(async () => {})), []);
  const planted = {
    'an import of serve': async (dir) => writeFile(join(dir, 'packages/run-adapters/src/host.ts'), "import { startServe } from '@parcha/agentrun-serve';\n"),
    'a dynamic import of a serve subpath': async (dir) => writeFile(join(dir, 'packages/run-adapters/src/host.ts'), "await import('@parcha/pi-durable-agent/serve');\n"),
    'a dependency on serve': async (dir) => {
      const file = join(dir, 'packages/run-adapters/package.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, '@parcha/agentrun-serve': '0.1.0-beta.27' } }));
    },
    'the Pi runtime in a harness package': async (dir) => {
      await mkdir(join(dir, 'packages/run-adapters-codex/src'), { recursive: true });
      await writeFile(join(dir, 'packages/run-adapters-codex/package.json'), JSON.stringify({ name: '@parcha/agentrun-codex' }));
      await writeFile(join(dir, 'packages/run-adapters-codex/src/index.ts'), "export { createPiRunner } from '@parcha/agentrun-pi';\n");
    },
  };
  for (const [name, plant] of Object.entries(planted)) assert.ok((await packageImportProblems(await workspace(plant))).length > 0, `${name} was not caught`);
});
