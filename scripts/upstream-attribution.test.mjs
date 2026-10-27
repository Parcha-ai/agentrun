// The attribution and boundary rules for packages that carry vercel-labs/durable-harness code: the real package passes,
// and each planted break goes red.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attributionProblems, carriesUpstream, NOTICE_LINE, shippedBy, specifiersOf, UPSTREAM, UPSTREAM_FILE } from './upstream-attribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'packages', 'run-adapters');
const scratch = await mkdtemp(join(tmpdir(), 'agentrun-attribution-'));
after(() => rm(scratch, { recursive: true, force: true }));

/** A packed-shape copy of the real package's attribution files, with a dist file, to plant breaks in. */
let made = 0;
async function packed(plant = async () => {}) {
  const dir = join(scratch, `p${made += 1}`);
  await mkdir(join(dir, 'dist'), { recursive: true });
  for (const name of ['NOTICE', 'LICENSE', 'package.json', UPSTREAM_FILE]) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await cp(join(packageDir, name), join(dir, name));
  }
  await writeFile(join(dir, 'dist', 'index.js'), "import { submitParameters } from '@parcha/agentrun-dsl';\nexport const x = 1;\n");
  await writeFile(join(dir, 'README.md'), '# @parcha/agentrun-adapters\n');
  await plant(dir);
  return dir;
}
const edit = async (file, change) => writeFile(file, change(await readFile(file, 'utf8')));

test('the package as it ships passes, and it is the one package that carries upstream code', async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.deepEqual(await attributionProblems(packageDir, { shipped: shippedBy(manifest) }), []);
  assert.deepEqual(await attributionProblems(await packed()), []);
  assert.equal(await carriesUpstream(packageDir), true);
  assert.equal(await carriesUpstream(join(root, 'packages', 'dsl')), false);
});

test("NOTICE says upstream's copyright line verbatim, the one at the pinned commit", async () => {
  assert.match(NOTICE_LINE, /, Copyright 2026 Vercel Inc\., licensed under the Apache License 2\.0\.$/);
  assert.equal(UPSTREAM.commit, 'ea8aa4060cf4fb8cd39737ce8ab21c4e0f40c741');
  const upstream = JSON.parse(await readFile(join(packageDir, UPSTREAM_FILE), 'utf8'));
  assert.deepEqual([upstream.repo, upstream.commit, upstream.copyright, upstream.license, upstream.notice], [UPSTREAM.repo, UPSTREAM.commit, UPSTREAM.copyright, 'Apache-2.0', null]);
});

test('each planted break goes red', async () => {
  const cases = {
    'a missing NOTICE': async (dir) => rm(join(dir, 'NOTICE')),
    'a missing LICENSE': async (dir) => rm(join(dir, 'LICENSE')),
    'a missing UPSTREAM.json': async (dir) => rm(join(dir, UPSTREAM_FILE)),
    'a NOTICE with another year': async (dir) => edit(join(dir, 'NOTICE'), (text) => text.replace('Copyright 2026 Vercel Inc.', 'Copyright 2025 Vercel Inc.')),
    'an UPSTREAM.json that claims a NOTICE': async (dir) => edit(join(dir, UPSTREAM_FILE), (text) => text.replace('"notice": null', '"notice": "NOTICE"')),
    'an UPSTREAM.json at another commit': async (dir) => edit(join(dir, UPSTREAM_FILE), (text) => text.replace(UPSTREAM.commit, '0'.repeat(40))),
    'a copied file recorded without its blob': async (dir) => edit(join(dir, UPSTREAM_FILE), (text) => text.replace('"files": {}', '"files": { "src/a.ts": { "upstream": "packages/x/src/a.ts" } }')),
    'a pristine upstream copy shipped': async (dir) => { await mkdir(join(dir, 'vendor/durable-harness/upstream/packages'), { recursive: true }); await writeFile(join(dir, 'vendor/durable-harness/upstream/packages/a.ts'), 'x'); },
    'a dependency on @workflow/world': async (dir) => edit(join(dir, 'package.json'), (text) => JSON.stringify({ ...JSON.parse(text), dependencies: { '@workflow/world': '5.0.5' } })),
    'a peer on @vercel/sandbox': async (dir) => edit(join(dir, 'package.json'), (text) => JSON.stringify({ ...JSON.parse(text), peerDependencies: { '@vercel/sandbox': '*' } })),
    'an import of @vercel/agent-runs': async (dir) => writeFile(join(dir, 'dist', 'runs.js'), "const r = await import('@vercel/agent-runs');\n"),
    'a require of @workflow/world-local': async (dir) => writeFile(join(dir, 'dist', 'w.cjs'), "const w = require('@workflow/world-local');\n"),
    'a Vercel mark in the README': async (dir) => writeFile(join(dir, 'README.md'), 'Runs in a Vercel Sandbox.\n'),
    'a mark in a compiled comment': async (dir) => writeFile(join(dir, 'dist', 'c.js'), '// through the AI Gateway\nexport {};\n'),
    'a logo image': async (dir) => writeFile(join(dir, 'dist', 'logo.png'), 'x'),
    'an SVG file': async (dir) => writeFile(join(dir, 'dist', 'mark.svg'), '<svg/>'),
    'SVG markup in a page': async (dir) => writeFile(join(dir, 'dist', 'page.html'), '<html><svg viewBox="0 0 1 1"></svg></html>'),
    'a Vercel header in a file that was not copied': async (dir) => writeFile(join(dir, 'dist', 'own.js'), '// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0.\nexport {};\n'),
  };
  for (const [name, plant] of Object.entries(cases)) {
    const problems = await attributionProblems(await packed(plant));
    assert.ok(problems.length > 0, `${name} was not caught`);
  }
});

test('a copied file may keep its header, which names Vercel, and only in its first lines', async () => {
  const header = '// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.\n// From github.com/vercel-labs/durable-harness, packages/harness-process/src/tail.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).\n// Changed by Parcha, 2026-10-27: imports.\n';
  const recorded = async (dir) => {
    await edit(join(dir, UPSTREAM_FILE), (text) => text.replace('"files": {}', `"files": { "src/tail.ts": { "upstream": "packages/harness-process/src/tail.ts", "blob": "${'a'.repeat(40)}", "sha256": "${'b'.repeat(64)}" } }`));
    await writeFile(join(dir, 'dist', 'tail.js'), `${header}export const tail = 1;\n`);
  };
  assert.deepEqual(await attributionProblems(await packed(recorded)), []);
  const late = await packed(async (dir) => { await recorded(dir); await writeFile(join(dir, 'dist', 'tail.js'), `${header}export const tail = 1;\n// a later line naming Vercel\n`); });
  assert.deepEqual(await attributionProblems(late), ['dist/tail.js:5 names Vercel or one of its marks']);
});

test('the specifier scan reads static, dynamic, re-exported and required modules', () => {
  assert.deepEqual(specifiersOf("import a from 'x';\nexport { b } from \"y/z\";\nconst c = await import('w');\nconst d = require('v');\nimport 'side';\n").sort(), ['side', 'v', 'w', 'x', 'y/z']);
});
