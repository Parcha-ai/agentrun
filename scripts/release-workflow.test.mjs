// The release workflow's job graph (.github/workflows/release.yml): which job waits for which, which ones the npm-release
// approval holds, and how AgentRun Server's image is built and released. The publish step itself is run in
// release-publish-step.test.mjs; the pypi and box jobs' own steps in python-release.test.mjs and box-recipe.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const { jobs } = workflow;
const needs = job => [jobs[job].needs ?? []].flat();
const pinned = steps => {
  for (const step of steps.filter(step => step.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} is pinned by commit`);
};

test('a gate job checks the tag and its CI run before anything else starts', () => {
  const { gate, publish } = jobs;
  assert.equal(gate.needs, undefined, 'the first job');
  assert.equal(gate.environment, undefined, 'no approval: it publishes nothing and holds no secret');
  assert.equal(gate.if, publish.if, 'where the release runs, and nowhere else');
  assert.deepEqual(gate.permissions, { contents: 'read', actions: 'read' }, 'reads the CI run, writes nothing');
  pinned(gate.steps);
  const at = pattern => gate.steps.findIndex(step => pattern.test(step.run ?? step.uses ?? ''));
  assert.equal(at(/\[\[ "\$RELEASE_TAG" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-beta\\\.\[0-9\]\+\$ \]\]/), 0, 'first, the tag is a beta tag');
  assert.match(gate.steps[0].run, /test "\$GITHUB_REF" = "refs\/tags\/\$RELEASE_TAG"/, 'dispatched at the tag it names');
  const checkout = gate.steps.find(step => /^actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkout.with.ref, '${{ inputs.tag }}');
  assert.ok(at(/^test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"$/) > at(/^actions\/checkout@/), 'the checkout is the provenance commit');
  const ci = gate.steps[at(/^node scripts\/release-ci-gate\.mjs$/)];
  assert.ok(ci, 'the tagged commit passed CI on main');
  assert.equal(ci.env.GH_TOKEN, '${{ github.token }}');
});

test('every other job starts after the gate, and the jobs npm-release holds all wait for it at the same moment, so one approval covers them', () => {
  for (const name of Object.keys(jobs).filter(name => name !== 'gate')) {
    assert.ok(needs(name).includes('gate') || needs(name).every(dep => needs(dep).includes('gate')), `${name} runs after the gate`);
  }
  const held = Object.keys(jobs).filter(name => jobs[name].environment === 'npm-release').sort();
  assert.deepEqual(held, ['box', 'publish', 'pypi'], 'the jobs that publish or read the release environment\'s secret');
  for (const name of held) assert.deepEqual(needs(name), ['gate'], `${name} waits for nothing but the gate, so it asks for approval with the others`);
});

test('the server image is built natively per architecture from the start, pushed by digest alone, and tagged only after the approved publish passes', () => {
  const { image, 'image-release': release, publish } = jobs;
  assert.deepEqual(needs('image'), ['gate'], 'it builds from the checkout, never from npm, so it does not wait for publish');
  assert.equal(image.environment, undefined);
  assert.equal(image.if, publish.if);
  assert.deepEqual(image.permissions, { contents: 'read', packages: 'write' });
  assert.equal(image['runs-on'], '${{ matrix.runner }}');
  assert.deepEqual(image.strategy.matrix.include.map(({ platform, runner }) => [platform, runner]), [['linux/amd64', 'ubuntu-24.04'], ['linux/arm64', 'ubuntu-24.04-arm']], 'each architecture on its own native runner');
  pinned(image.steps);
  assert.ok(!image.steps.some(step => /setup-qemu-action/.test(step.uses ?? '')), 'no emulation');
  const checkout = image.steps.find(step => /^actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkout.with.ref, '${{ inputs.tag }}');
  assert.ok(image.steps.some(step => step.run === 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), 'the checkout is the provenance commit');
  const build = image.steps.find(step => /^docker\/build-push-action@/.test(step.uses ?? ''));
  assert.equal(build.with.file, 'packages/serve/docker/Dockerfile');
  assert.equal(build.with.platforms, '${{ matrix.platform }}');
  assert.equal(build.with.provenance, 'mode=max');
  assert.equal(build.with.sbom, true);
  assert.equal(build.with.tags, undefined, 'no tag: a build is pushed by its digest alone');
  assert.equal(build.with.push, undefined);
  assert.equal(build.with.outputs, 'type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true');
  const buildx = image.steps.find(step => /^docker\/setup-buildx-action@/.test(step.uses ?? ''));
  assert.match(buildx.with['driver-opts'], /@sha256:[0-9a-f]{64}$/, 'BuildKit by digest');
  const kept = image.steps.find(step => /^actions\/upload-artifact@/.test(step.uses ?? ''));
  assert.equal(kept.with.name, 'image-digest-${{ matrix.arch }}');

  assert.deepEqual(needs('image-release').sort(), ['image', 'publish'], 'tagged once the approved packages are published and verified, and both builds are pushed');
  assert.equal(release.environment, undefined, 'it runs only after the approved publish job, with this run\'s GITHUB_TOKEN');
  assert.equal(release.if, publish.if);
  assert.deepEqual(release.permissions, { contents: 'read', packages: 'write' });
  assert.equal(release.env.IMAGE, image.env.IMAGE);
  assert.equal(image.env.IMAGE, 'ghcr.io/parcha-ai/agentrun-server');
  pinned(release.steps);
  const fetched = release.steps.find(step => /^actions\/download-artifact@/.test(step.uses ?? ''));
  assert.equal(fetched.with.pattern, 'image-digest-*');
  assert.equal(fetched.with['merge-multiple'], true);
  const tag = release.steps.find(step => /imagetools create/.test(step.run ?? ''));
  assert.match(tag.run, /\[ "\$#" -eq 2 \] \|\|/, 'exactly the two architectures');
  assert.match(tag.run, /--tag "\$IMAGE:\$RELEASE_TAG" --tag "\$IMAGE:beta"/, 'the release tag and beta, as before');
});
