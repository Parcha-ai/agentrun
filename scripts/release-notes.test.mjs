import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fold } from './changes.mjs';
import { changelogSection, installLines, MAX_BODY, releaseNotes, releaseVersions } from './release-notes.mjs';

const exec = promisify(execFile);

// The shape the release pull requests of beta.41 to beta.43 wrote: a release with blocks (beta.41), plain bullets with an
// "Upgrading:" sub-bullet (beta.42 and beta.43), and the old heading style below them.
const changelog = `# Changelog

## Unreleased

## 0.1.0-beta.43 (2026-11-17)

- The old learning promotion loop is gone. A learned workflow has one path to serving.
    - DSL: step guards are removed.
    - Upgrading: delete \`guard\` from every learned workflow.
- The Cloudflare relay no longer answers a create with a bare 500 when its container is slow to start.
- Reduce repeated work when importing large Codex histories.
- On Android, a compact \`ui.observe\` lists the rows of a clickable list.
- A tag carried this one past the release pull request's fold.

## 0.1.0-beta.42 (2026-11-17)

- A learned workflow is compiled once and checked once against the agent's own answers.
    - Upgrading: promotion is now by agreement with the agent's own answers.

## 0.1.0-beta.41 (2026-11-16)

**Upgrading and going back:**

- Keep the same data folder and start command, and change only the image. Upgrade the server first, then the runners.
- SQLite keeps schema version 11: the server adds the nullable \`runs.labels\` column.
  Going back is setting the image back to \`v0.1.0-beta.40\`.
- Postgres goes from schema version 14 to 16 at the server's start.
- Going back to beta.40 turns every feed trigger off.

**Breaking:**

- \`@parcha/agentrun-computer\`: \`MachineHost.exec\` is optional.

**Known issues:**

- A feed that answers slowly holds its poll.

**Changes:**

- A feed trigger starts a run for each new item <of a feed> & more.

## 0.1.0-beta.12, 2026-10-09

- Old style heading.
`;

test('the section is the version\'s, as the fold left it: every line under its heading up to the next version, and nothing of the others', () => {
  const beta43 = changelogSection(changelog, '0.1.0-beta.43');
  assert.match(beta43, /^- The old learning promotion loop is gone/);
  assert.match(beta43, /- A tag carried this one past the release pull request's fold\.$/, 'the bullet the publish job\'s fold added is in it');
  assert.doesNotMatch(beta43, /beta\.42|compiled once/);
  const beta41 = changelogSection(changelog, '0.1.0-beta.41');
  assert.match(beta41, /^\*\*Upgrading and going back:\*\*\n\n- Keep the same data folder/);
  assert.match(beta41, /\*\*Known issues:\*\*\n\n- A feed that answers slowly holds its poll\./);
  assert.match(beta41, /<of a feed> & more\.$/);
  assert.equal(changelogSection(changelog, '0.1.0-beta.12'), '- Old style heading.');
  assert.throws(() => changelogSection(changelog, '0.1.0-beta.44'), /CHANGELOG\.md has no section for 0\.1\.0-beta\.44/);
  assert.throws(() => changelogSection(changelog, '0.1.0-beta.4'), /no section for 0\.1\.0-beta\.4\b/, 'beta.4 is not beta.43 or beta.41');
  assert.throws(() => changelogSection('# Changelog\n\n## Unreleased\n\n## 0.1.0-beta.44 (2026-11-18)\n\n## 0.1.0-beta.43 (2026-11-17)\n\n- x\n', '0.1.0-beta.44'), /section for 0\.1\.0-beta\.44 is empty/);
});

test('the section the notes and the post read carries no fragment marker: a marker after a line\'s words goes, a line of markers alone goes with them, and the rest is as written', () => {
  const marked = changelog
    .replace('- The Cloudflare relay no longer answers a create with a bare 500 when its container is slow to start.', '$& <!-- changes/relay-500.md -->')
    .replace('    - Upgrading: delete `guard` from every learned workflow.', '$&\n    <!-- changes/learning-guards.md --> <!-- changes/learning-loop.md -->')
    .replace('- Keep the same data folder and start command, and change only the image. Upgrade the server first, then the runners.', '$& <!-- changes/upgrade.md -->');
  assert.notEqual(marked, changelog);
  for (const version of ['0.1.0-beta.43', '0.1.0-beta.41']) {
    const section = changelogSection(marked, version);
    assert.doesNotMatch(section, /<!--|-->/, version);
    assert.equal(section, changelogSection(changelog, version), `${version} reads as it did before the markers`);
  }
  assert.doesNotMatch(releaseNotes({ section: changelogSection(marked, '0.1.0-beta.43'), install: '## Install\n\n- x', tag: 'v0.1.0-beta.43', repository: 'o/r' }), /<!--/);
});

test('the notes of a section the fold gave a breaking change show the Breaking heading with its bullet under it, in a release pull request\'s section and in a plain one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-release-notes-fold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'packages'));
  await mkdir(join(dir, 'changes'));
  const fragments = () => Promise.all([
    writeFile(join(dir, 'changes/late-break.md'), '---\npackages: repo\nkind: breaking\n---\nLate break.\n'),
    writeFile(join(dir, 'changes/late-fix.md'), '---\npackages: repo\nkind: fix\n---\nLate fix.\n'),
  ]);
  const install = '## Install\n\n- x';
  const notes = async version => releaseNotes({ section: changelogSection(await readFile(join(dir, 'CHANGELOG.md'), 'utf8'), version), install, tag: `v${version}`, repository: 'o/r' });
  // beta.41's section, its blocks written by its release pull request, takes what a tag carried past that pull request's fold.
  await writeFile(join(dir, 'CHANGELOG.md'), changelog);
  await fragments();
  await fold(dir, '0.1.0-beta.41', '2026-11-16', { previous: null });
  const curated = await notes('0.1.0-beta.41');
  assert.match(curated, /\n\*\*Breaking:\*\*\n\n- `@parcha\/agentrun-computer`: `MachineHost\.exec` is optional\.\n- Late break\.\n\n\*\*Known issues:\*\*\n/);
  assert.equal(curated.match(/\*\*Breaking:\*\*/g).length, 1, 'one Breaking heading');
  assert.match(curated, /- A feed trigger starts a run for each new item <of a feed> & more\.\n- Late fix\.\n\n## Install\n/);
  // A section of plain bullets, as the fold alone writes one, gets the heading.
  await fragments();
  await fold(dir, '0.1.0-beta.45', '2026-11-18', { previous: null });
  assert.equal(await notes('0.1.0-beta.45'), '**Breaking:**\n\n- Late break.\n\n**Changes:**\n\n- Late fix.\n\n## Install\n\n- x\n');
  // The changelog holds each folded bullet's marker; the notes made from it hold none.
  assert.equal((await readFile(join(dir, 'CHANGELOG.md'), 'utf8')).match(/^- Late fix\. <!-- changes\/late-fix\.md -->$/gm)?.length, 2, 'beta.41\'s and beta.45\'s');
});

test('the install lines name the npm version, the launcher\'s, the Python client\'s, the image tag with its platforms, and the Helm chart', () => {
  const lines = installLines({ version: '0.1.0-beta.44', launcher: '0.4.12', python: '0.3.12', image: 'ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.44', platforms: ['linux/amd64', 'linux/arm64'], chart: 'oci://ghcr.io/parcha-ai/charts/agentrun' });
  assert.equal(lines, [
    '## Install',
    '',
    '- Server: `npx @parcha/agentrun-serve@0.1.0-beta.44`; every `@parcha/agentrun-*` package of this release is 0.1.0-beta.44 on npm',
    '- Launcher and CLI: `npx @parcha/agentrun@0.4.12`',
    '- Python client: `pip install parcha-agentrun==0.3.12`',
    '- Server image: `docker pull ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.44` (linux/amd64, linux/arm64)',
    '- Helm chart: `helm install agentrun oci://ghcr.io/parcha-ai/charts/agentrun --version 0.1.0-beta.44`',
  ].join('\n'));
  assert.throws(() => installLines({ version: '0.1.0-beta.44', launcher: '0.4.12', python: '0.3.12', image: 'i:t', platforms: ['linux/amd64'] }), /chart/);
  assert.throws(() => installLines({ version: '0.1.0-beta.44', launcher: '0.4.12', python: undefined, image: 'i:t', platforms: ['linux/amd64'] }), /python/);
  assert.throws(() => installLines({ version: '0.1.0-beta.44', launcher: '0.4.12', python: '0.3.12', image: 'i:t', platforms: [], chart: 'oci://c' }), /platforms/);
});

test('this checkout\'s versions: the workspace\'s, the launcher\'s own line and the Python client\'s', () => {
  const { version, launcher, python } = releaseVersions();
  for (const value of [version, launcher, python]) assert.match(value, /^\d+\.\d+\.\d+/);
  assert.notEqual(launcher, version, '@parcha/agentrun is on a line of its own');
});

test('the notes are the section, then the install lines; a body over GitHub\'s limit is cut at a line and points at the change fragments at the tag', () => {
  const install = '## Install\n\n- x';
  const section = changelogSection(changelog, '0.1.0-beta.43');
  assert.equal(releaseNotes({ section, install, tag: 'v0.1.0-beta.43', repository: 'o/r' }), `${section}\n\n${install}\n`);
  const long = Array.from({ length: 5000 }, (_, i) => `- Entry ${i} ${'x'.repeat(40)}`).join('\n');
  const cut = releaseNotes({ section: long, install, tag: 'v0.1.0-beta.43', repository: 'o/r' });
  assert.ok(cut.length <= MAX_BODY, `${cut.length} characters`);
  assert.ok(MAX_BODY <= 125_000, 'under GitHub\'s release body limit');
  // CHANGELOG.md at the tag has no section for this version (the fold is not committed); the tag's changes/ fragments are its notes.
  assert.match(cut, /\n- Entry \d+ x+\n\nThe rest of this release's changes are in \[its fragments in changes\/ at v0\.1\.0-beta\.43\]\(https:\/\/github\.com\/o\/r\/tree\/v0\.1\.0-beta\.43\/changes\)\.\n\n## Install\n\n- x\n$/);
  assert.equal(cut.match(/\]\((https:[^)]+)\)/)[1], 'https://github.com/o/r/tree/v0.1.0-beta.43/changes', 'the cut body\'s link is the tag\'s changes/ folder');
});

test('the command writes the notes from a folded changelog and this checkout\'s versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-release-notes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { version } = releaseVersions();
  await writeFile(join(dir, 'CHANGELOG.md'), changelog.replace('0.1.0-beta.43 (', `${version} (`));
  const script = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
  await exec(process.execPath, [script, '--tag', `v${version}`, '--changelog', join(dir, 'CHANGELOG.md'), '--image', `ghcr.io/parcha-ai/agentrun-server:v${version}`, '--platforms', 'linux/amd64,linux/arm64', '--chart', 'oci://ghcr.io/parcha-ai/charts/agentrun', '--out', join(dir, 'notes.md')]);
  const notes = await readFile(join(dir, 'notes.md'), 'utf8');
  assert.match(notes, /^- The old learning promotion loop is gone/);
  assert.match(notes, new RegExp(`- Server image: \`docker pull ghcr\\.io/parcha-ai/agentrun-server:v${version.replace(/\./g, '\\.')}\` \\(linux/amd64, linux/arm64\\)\\n`));
  assert.match(notes, new RegExp(`- Helm chart: \`helm install agentrun oci://ghcr\\.io/parcha-ai/charts/agentrun --version ${version.replace(/\./g, '\\.')}\`\\n$`));
  const refused = await exec(process.execPath, [script, '--tag', 'v0.0.1', '--changelog', join(dir, 'CHANGELOG.md'), '--image', 'i:t', '--platforms', 'linux/amd64', '--chart', 'oci://c', '--out', join(dir, 'other.md')]).then(() => null, error => error);
  assert.ok(refused, 'a tag that is not this checkout\'s version stops');
  assert.match(refused.stderr, /v0\.0\.1 is not this checkout's version/);
});
