// The console's THIRD-PARTY-NOTICES.txt (apps/console/third-party-notices.mjs), from a bundle's module ids: every package a
// module is in, once, with its version, its license and its license text; the console's and the repository's own source never.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { noticesFor, packageDirOf, thirdPartyNotices } from '../apps/console/third-party-notices.mjs';

async function tree(fn) {
  const root = await mkdtemp(join(tmpdir(), 'console-notices-'));
  const put = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  try { await fn(root, put); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a module id names the package it is in: the innermost node_modules, a scope kept, a query and a virtual prefix ignored', () => {
  assert.equal(packageDirOf('/w/apps/console/node_modules/react/cjs/react.production.min.js'), '/w/apps/console/node_modules/react');
  assert.equal(packageDirOf('/w/node_modules/@fontsource/jetbrains-mono/index.css?used'), '/w/node_modules/@fontsource/jetbrains-mono');
  assert.equal(packageDirOf('\0/w/node_modules/a/node_modules/b/index.js'), '/w/node_modules/a/node_modules/b');
  assert.equal(packageDirOf('/w/apps/console/src/App.tsx'), undefined, "the console's own source");
  assert.equal(packageDirOf('/w/packages/dsl/src/graph.ts'), undefined, "the repository's own source");
  assert.equal(packageDirOf('/w/node_modules/@scope'), undefined, 'a scope with no package');
});

test('each bundled package once, sorted, with its version, license and every license file; none for own source', () => tree(async (root, put) => {
  await put('node_modules/react/package.json', JSON.stringify({ name: 'react', version: '18.3.1', license: 'MIT' }));
  await put('node_modules/react/LICENSE', 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n');
  await put('node_modules/@fontsource/jetbrains-mono/package.json', JSON.stringify({ name: '@fontsource/jetbrains-mono', version: '5.1.1', license: 'OFL-1.1' }));
  await put('node_modules/@fontsource/jetbrains-mono/LICENSE', 'SIL Open Font License, Version 1.1\n');
  await put('node_modules/dompurify/package.json', JSON.stringify({ name: 'dompurify', version: '3.2.3', license: '(MPL-2.0 OR Apache-2.0)' }));
  await put('node_modules/dompurify/LICENSE', 'Apache and MPL\n');
  await put('node_modules/bare/package.json', JSON.stringify({ name: 'bare', version: '1.0.0', license: 'ISC' }));
  const { packages, text } = noticesFor([
    `${root}/node_modules/react/index.js`, `${root}/node_modules/react/cjs/react.production.min.js`,
    `${root}/node_modules/@fontsource/jetbrains-mono/index.css`, `${root}/node_modules/dompurify/dist/purify.es.mjs`,
    `${root}/node_modules/bare/index.js`, `${root}/apps/console/src/main.tsx`,
  ]);
  assert.deepEqual(packages, [
    { name: '@fontsource/jetbrains-mono', version: '5.1.1', license: 'OFL-1.1' },
    { name: 'bare', version: '1.0.0', license: 'ISC' },
    { name: 'dompurify', version: '3.2.3', license: '(MPL-2.0 OR Apache-2.0)' },
    { name: 'react', version: '18.3.1', license: 'MIT' },
  ]);
  assert.match(text, /^Third-party software in the AgentRun console\n/);
  assert.match(text, /react 18\.3\.1 \(MIT\)\n\nMIT License\n\nCopyright \(c\) Meta Platforms/);
  assert.match(text, /^dompurify 3\.2\.3 \(MPL-2\.0 OR Apache-2\.0\)\n/m, 'an SPDX expression keeps its own parentheses, not two pairs');
  assert.match(text, /@fontsource\/jetbrains-mono 5\.1\.1 \(OFL-1\.1\)\n\nSIL Open Font License/);
  assert.match(text, /bare 1\.0\.0 \(ISC\)\n\n\(The package ships no license file; its manifest names ISC\.\)/);
  assert.equal(text.match(/^react 18\.3\.1/gm).length, 1, 'a package many modules come from is listed once');
}));

test('the Vite plugin emits the notices beside index.html from every chunk and every asset of the bundle, and only at build', () => tree(async (root, put) => {
  await put('node_modules/clsx/package.json', JSON.stringify({ name: 'clsx', version: '2.1.1', license: 'MIT' }));
  await put('node_modules/clsx/license', 'MIT License\n');
  await put('node_modules/@fontsource/schibsted-grotesk/package.json', JSON.stringify({ name: '@fontsource/schibsted-grotesk', version: '5.1.1', license: 'OFL-1.1' }));
  await put('node_modules/@fontsource/schibsted-grotesk/LICENSE', 'SIL Open Font License, Version 1.1\n');
  const plugin = thirdPartyNotices();
  assert.equal(plugin.apply, 'build');
  plugin.configResolved({ root });
  const emitted = [];
  plugin.generateBundle.call({ emitFile: file => emitted.push(file) }, {}, {
    'assets/index.js': { type: 'chunk', moduleIds: [`${root}/node_modules/clsx/dist/clsx.mjs`, `${root}/src/main.tsx`] },
    // A font a stylesheet imports reaches the bundle as an asset, never as a module: Vite names its source from its root.
    'assets/schibsted-grotesk-latin-400-normal-x1.woff2': { type: 'asset', source: '', originalFileNames: ['node_modules/@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-400-normal.woff2'] },
    'assets/index.css': { type: 'asset', source: '', originalFileNames: [] },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].fileName, 'THIRD-PARTY-NOTICES.txt');
  assert.match(emitted[0].source, /clsx 2\.1\.1 \(MIT\)\n\nMIT License/);
  assert.match(emitted[0].source, /@fontsource\/schibsted-grotesk 5\.1\.1 \(OFL-1\.1\)\n\nSIL Open Font License/);
}));
