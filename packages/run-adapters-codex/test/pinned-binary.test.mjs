// The Codex check imports nothing outside this package: serve's image check runs dist/verify.js in a tree that holds this
// package and Codex alone. So its chunked hash and its once-per-binary memo are a copy of the kernel's (claude-agent's
// adapter uses that one), held line for line the same here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** A file's code: its text after the comment lines it opens with. */
const codeOf = (url) => readFileSync(url, 'utf8').replace(/^(\/\/.*\n)+/, '');

test("the check imports only Node's own modules and this package's files", () => {
  for (const file of ['verify.js', 'pinned-binary.js', 'binary.js', 'versions.js']) {
    const text = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
    const from = [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    assert.deepEqual(from.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('./')), [], `${file} imports ${from.join(', ')}`);
  }
});

test("the chunked hash and the memo are the kernel's, line for line", () => {
  assert.equal(codeOf(new URL('../src/pinned-binary.ts', import.meta.url)), codeOf(new URL('../../run-adapters/src/host/pinned-binary.ts', import.meta.url)));
});
