// An example installs its @parcha packages from npm at the version its manifest pins, and the guide that sends an author to
// it says to copy it from the release tag they run (HARNESS.md), so its pins must be that release's: every @parcha
// dependency an example names by version is the workspace version (the root package.json's). The release pull request
// that bumps the workspace bumps these with it, and this fails on one that forgets. A `file:` link is the checkout's own
// package, at the workspace version already.
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

test("every example's @parcha pins are the workspace version", () => {
  const pins = [];
  for (const example of readdirSync(join(root, 'examples'), { withFileTypes: true })) {
    const manifest = join(root, 'examples', example.name, 'package.json');
    if (!example.isDirectory() || !existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const field of FIELDS) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        if (name.startsWith('@parcha/') && !spec.startsWith('file:')) pins.push({ at: `examples/${example.name}/package.json ${field}.${name}`, spec });
      }
    }
  }
  assert.ok(pins.some(pin => pin.at.startsWith('examples/starter/')) && pins.some(pin => pin.at.startsWith('examples/harness-module/')), `the starter and the harness module pin their packages: ${JSON.stringify(pins)}`);
  const off = pins.filter(pin => pin.spec !== workspace).map(pin => `${pin.at} is ${pin.spec}`);
  assert.deepEqual(off, [], `Each must be the workspace version, ${workspace}. A release pull request bumps the examples' @parcha pins with the workspace version (an author copies an example from the release tag, so its pins are that release's).`);
});
