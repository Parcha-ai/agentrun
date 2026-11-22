// The release workflow's job graph (.github/workflows/release.yml): which job waits for which, which ones the npm-release
// approval holds, and how AgentRun Server's image is built and released. The publish step itself is run in
// release-publish-step.test.mjs; the pypi and box jobs' own steps in python-release.test.mjs and box-recipe.test.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const exec = promisify(execFile);

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
  const version = gate.steps[at(/^node scripts\/release-version\.mjs --tag "\$RELEASE_TAG"$/)];
  assert.ok(version, 'the tag is newer than what is out, and is the version its manifests say');
  assert.equal(version.env.GH_TOKEN, '${{ github.token }}', 'it reads the repository\'s releases');
  assert.ok(at(/^actions\/setup-node@/) < at(/^node scripts\/release-version\.mjs/), 'with the pinned Node');
});

// Every job a job waits for, and every job those wait for.
const upstream = (name, seen = new Set()) => { for (const dep of needs(name)) if (!seen.has(dep)) { seen.add(dep); upstream(dep, seen); } return seen; };

test('every other job starts after the gate, and the jobs npm-release holds all wait for it at the same moment, so one approval covers them', () => {
  for (const name of Object.keys(jobs).filter(name => name !== 'gate')) assert.ok(upstream(name).has('gate'), `${name} runs after the gate`);
  const held = Object.keys(jobs).filter(name => jobs[name].environment === 'npm-release').sort();
  assert.deepEqual(held, ['box', 'media', 'publish', 'pypi'], 'the jobs that publish or read the release environment\'s secret');
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
  const evidence = publish.steps.find(step => /^actions\/upload-artifact@/.test(step.uses ?? '') && /^beta-release-/.test(step.with.name));
  assert.equal(kept.with['retention-days'], evidence.with['retention-days'], 'kept as long as the release evidence, so a re-run of image-release days later still finds the digests');

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

test('the Helm chart is packaged from Chart.yaml as it stands and pushed once its image is tagged, with this run\'s token; its logged-out read holds nothing', () => {
  const { chart } = jobs;
  const read = jobs['chart-public'];
  assert.deepEqual(needs('chart'), ['image-release'], 'the image the chart installs is tagged first');
  assert.equal(chart.if, jobs.publish.if);
  assert.equal(chart.environment, undefined, 'no secret: this run\'s GITHUB_TOKEN, as image-release');
  assert.deepEqual(chart.permissions, { contents: 'read', packages: 'write' });
  assert.equal(chart.env.CHART, 'oci://ghcr.io/parcha-ai/charts');
  pinned(chart.steps);
  const checkout = chart.steps.find(step => /^actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkout.with.ref, '${{ inputs.tag }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(chart.steps.some(step => step.run === 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), 'the checkout is the provenance commit');
  const packaged = stepAt('chart', /^helm lint deploy\/helm\/agentrun\nhelm package deploy\/helm\/agentrun --destination "\$RUNNER_TEMP\/chart"\n$/);
  const pushed = stepAt('chart', /helm push "\$RUNNER_TEMP\/chart\/agentrun-\$\{RELEASE_TAG#v\}\.tgz" "\$CHART"\n\s*helm registry logout ghcr\.io/);
  assert.ok(packaged >= 0 && pushed > packaged, 'packaged at Chart.yaml\'s version (no --version or --app-version: the release pull request\'s CI holds it to the tag), then pushed and logged out');
  const push = chart.steps[pushed];
  assert.equal(push.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}', 'only the push step holds the token');
  assert.match(push.run, /--password-stdin/, 'never on a command line');
  assert.equal(chart.steps.filter(step => JSON.stringify(step).includes('secrets.')).length, 1);

  assert.deepEqual(needs('chart-public'), ['chart']);
  assert.equal(read.if, jobs.publish.if);
  assert.deepEqual(read.permissions, {}, 'no token at all: the read is anyone\'s');
  assert.doesNotMatch(JSON.stringify(read), /secrets\.|github\.token|registry login/);
  pinned(read.steps);
  assert.ok(stepAt('chart-public', /^helm show chart "\$CHART\/agentrun" --version "\$\{RELEASE_TAG#v\}"/) >= 0);
  assert.equal(read.env.CHART, chart.env.CHART);
  for (const name of Object.keys(jobs)) assert.ok(!upstream(name).has('chart-public'), `${name} never waits for the package's visibility`);
});

const raw = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const stepAt = (job, pattern) => jobs[job].steps.findIndex(step => pattern.test(step.run ?? step.uses ?? ''));

test('the publish job keeps the changelog its fold wrote, right after the fold, for the release notes', () => {
  const fold = stepAt('publish', /^node scripts\/changes\.mjs --fold "\$\{RELEASE_TAG#v\}"$/);
  const kept = jobs.publish.steps[fold + 1];
  assert.match(kept.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'the next step, before anything is installed or built; pinned by commit');
  assert.equal(kept.with.name, 'release-changelog');
  assert.equal(kept.with.path, 'CHANGELOG.md');
  assert.equal(kept.with['if-no-files-found'], 'error');
  assert.equal(kept.with.overwrite, true, 'a re-run of publish keeps its own fold');
});

test('the GitHub release is published once every publish job passed, from the folded changelog, by the only job that may write the repository', () => {
  const release = jobs['github-release'];
  assert.deepEqual(needs('github-release').sort(), ['box', 'chart', 'image-release', 'media', 'publish', 'pypi'], 'after npm, PyPI, the server image, the Helm chart, the box image and the media image');
  assert.equal(release.if, jobs.publish.if);
  assert.equal(release.environment, undefined, 'no secret: the approval was given to the jobs it waits for');
  assert.deepEqual(release.permissions, { contents: 'write' });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(jobs)) if (name !== 'github-release') assert.notEqual(job.permissions?.contents, 'write', `${name} does not write the repository`);
  pinned(release.steps);
  const checkout = release.steps.find(step => /^actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkout.with.ref, '${{ inputs.tag }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(release.steps.some(step => step.run === 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), 'the checkout is the provenance commit');
  const fetched = release.steps[stepAt('github-release', /^actions\/download-artifact@/)];
  assert.equal(fetched.with.name, 'release-changelog', 'the fold\'s own output, not a second fold');
  const notes = release.steps[stepAt('github-release', /^node scripts\/release-notes\.mjs /)];
  assert.match(notes.run, /--tag "\$RELEASE_TAG" --changelog "\$\{\{ runner\.temp \}\}\/changelog\/CHANGELOG\.md" --image "\$IMAGE:\$RELEASE_TAG" --platforms "\$PLATFORMS" --chart oci:\/\/ghcr\.io\/parcha-ai\/charts\/agentrun --out "\$\{\{ runner\.temp \}\}\/notes\.md"/);
  assert.match(notes.run, new RegExp(`--chart ${jobs.chart.env.CHART.replace(/[./]/g, '\\$&')}/agentrun `), 'the chart the chart job pushed');
  assert.equal(fetched.with.path, '${{ runner.temp }}/changelog');
  assert.equal(release.env.IMAGE, jobs.image.env.IMAGE, 'the image the image job built');
  assert.equal(release.env.PLATFORMS, jobs.image.strategy.matrix.include.map(entry => entry.platform).join(','), 'its platforms, as the image job builds them');
  const publish = release.steps[stepAt('github-release', /^node scripts\/release-github\.mjs /)];
  assert.ok(stepAt('github-release', /^node scripts\/release-notes\.mjs /) < stepAt('github-release', /^node scripts\/release-github\.mjs /));
  assert.equal(publish.run, 'node scripts/release-github.mjs --tag "$RELEASE_TAG" --notes "${{ runner.temp }}/notes.md"');
  assert.equal(publish.env.GH_TOKEN, '${{ github.token }}');
  assert.doesNotMatch(raw, /gh release create|git tag|git push/, 'nothing creates or moves a tag');
});

test('the release posts nowhere on its own: no job reads a Slack secret or variable', () => {
  assert.equal(jobs.slack, undefined);
  assert.doesNotMatch(raw, /SLACK_|slack\.com|release-slack/, 'the person who cut the release posts its summary (docs/releasing.md)');
});

test('the website import pull request is opened after the GitHub release with the website App\'s token, and never fails or blocks the release', async () => {
  const site = jobs.website;
  assert.deepEqual(needs('website').sort(), ['github-release', 'publish'], 'after the packages are published and the GitHub prerelease is out');
  assert.equal(site.if, jobs.publish.if);
  assert.equal(site['continue-on-error'], true, 'its failure leaves the run green');
  assert.equal(site.environment, undefined);
  assert.deepEqual(site.permissions, { contents: 'read' }, 'the App token writes the website; this run\'s token only reads');
  pinned(site.steps);
  // The App is configured: both, or the job says so and stops, green.
  const check = site.steps[0];
  assert.equal(check.id, 'app');
  assert.equal(check.env.APP_ID, '${{ vars.WEBSITE_APP_ID }}');
  assert.equal(check.env.APP_KEY, '${{ secrets.WEBSITE_APP_PRIVATE_KEY }}');
  for (const [env, ready, notice] of [[{}, 'false', true], [{ APP_ID: '1' }, 'false', true], [{ APP_KEY: 'k' }, 'false', true], [{ APP_ID: '1', APP_KEY: 'k' }, 'true', false]]) {
    const dir = await mkdtemp(join(tmpdir(), 'agentrun-website-check-'));
    try {
      const out = join(dir, 'output');
      await writeFile(out, '');
      const { stdout } = await exec('bash', ['-e', '-c', check.run], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
      assert.equal((await readFile(out, 'utf8')).trim(), `ready=${ready}`, JSON.stringify(env));
      if (notice) assert.equal(stdout.trim(), '::notice::website import skipped: WEBSITE_APP_ID / WEBSITE_APP_PRIVATE_KEY unset');
      else assert.equal(stdout.trim(), '');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  for (const step of site.steps.slice(1)) assert.equal(step.if, "steps.app.outputs.ready == 'true'", `${step.name ?? step.uses} runs only with the App configured`);
  const token = site.steps.find(step => /^actions\/create-github-app-token@[0-9a-f]{40}$/.test(step.uses ?? ''));
  assert.ok(token, 'the App token, pinned by commit');
  // The App is installed on more repositories than the website: the token names the website alone, and only the two writes it makes.
  assert.equal(token.with.owner, 'Parcha-ai');
  assert.equal(token.with.repositories, 'agentrun-website', 'the token is scoped to the website repository alone');
  const permissions = Object.fromEntries(Object.entries(token.with).filter(([key]) => key.startsWith('permission-')));
  assert.deepEqual(permissions, { 'permission-contents': 'write', 'permission-pull-requests': 'write' }, 'push the branch, open the pull request, nothing else');
  assert.deepEqual(token.with, { 'app-id': '${{ vars.WEBSITE_APP_ID }}', 'private-key': '${{ secrets.WEBSITE_APP_PRIVATE_KEY }}', owner: 'Parcha-ai', repositories: 'agentrun-website', ...permissions });
  const checkouts = site.steps.filter(step => /^actions\/checkout@/.test(step.uses ?? ''));
  const agentrun = checkouts.find(step => step.with.path === 'agentrun');
  assert.equal(agentrun.with.ref, '${{ inputs.tag }}');
  assert.equal(agentrun.with['fetch-depth'], 0, 'every tag and commit, which the import reads');
  assert.equal(agentrun.with['persist-credentials'], false);
  assert.ok(site.steps.some(step => step['working-directory'] === 'agentrun' && step.run === 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), 'the checkout is the provenance commit');
  const web = checkouts.find(step => step.with.path === 'website');
  assert.deepEqual(web.with, { repository: 'Parcha-ai/agentrun-website', ref: 'main', path: 'website', token: `\${{ steps.${token.id}.outputs.token }}` });
  const imported = site.steps.find(step => /import-content\.py/.test(step.run ?? ''));
  assert.equal(imported['working-directory'], 'website');
  assert.equal(imported.run, 'python3 scripts/import-content.py "$RELEASE_TAG" --release-tag "$RELEASE_TAG" --repo "$GITHUB_WORKSPACE/agentrun"');
  const opened = site.steps.find(step => /release-website\.mjs/.test(step.run ?? ''));
  assert.equal(opened.run, 'node agentrun/scripts/release-website.mjs --tag "$RELEASE_TAG" --website website');
  assert.equal(opened.env.GH_TOKEN, `\${{ steps.${token.id}.outputs.token }}`);
  assert.equal(opened.env.APP_SLUG, `\${{ steps.${token.id}.outputs.app-slug }}`);
  const at = pattern => site.steps.findIndex(step => pattern.test(step.run ?? step.uses ?? ''));
  assert.ok(at(/^actions\/create-github-app-token@/) < at(/import-content\.py/) && at(/import-content\.py/) < at(/release-website\.mjs/));
});

test('anyone who can dispatch the workflow can release: no actor check; the npm-release environment\'s reviewers approve', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['tag']);
  const actors = raw.split('\n').filter(line => /github\.(actor|triggering_actor)|github\.event\.sender/.test(line));
  assert.ok(actors.length > 0);
  for (const line of actors) assert.match(line.trim(), /^username: \$\{\{ github\.actor \}\}$/, 'the actor only logs in to the registry');
  for (const [name, job] of Object.entries(jobs)) {
    assert.doesNotMatch(String(job.if ?? ''), /actor|sender/, `${name} runs for anyone`);
    for (const step of job.steps ?? []) assert.doesNotMatch(String(step.if ?? ''), /actor|sender/, `a step of ${name} runs for anyone`);
  }
  const held = Object.keys(jobs).filter(name => jobs[name].environment !== undefined);
  for (const name of held) assert.equal(jobs[name].environment, 'npm-release', `${name}'s approval is the environment's`);
});
