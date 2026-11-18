// The GitHub release's notes: the version's section of CHANGELOG.md as the release workflow's fold left it (the publish job keeps
// that file as the release-changelog artifact, so the notes say what the published archives' changelogs say), then how to install
// the release: the npm version, the launcher's, the Python client's, and the server image with its platforms.
//   node scripts/release-notes.mjs --tag v0.1.0-beta.44 --changelog <folded CHANGELOG.md> --image <ref> --platforms linux/amd64,linux/arm64 --out <file>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVersionHeading, pythonVersionOf, withoutMarkers } from './changes.mjs';
import { isMain } from './is-main.mjs';

// GitHub refuses a release body over 125,000 characters; the notes stay under it with room to spare.
export const MAX_BODY = 120_000;

/** The lines of `version`'s section of a changelog's text, its heading left out, the fold's fragment markers taken out (`withoutMarkers`)
 *  and blank lines trimmed: what the release notes and the Slack post show. Throws when it has none or it is empty. */
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex(line => isVersionHeading(line, version));
  if (at < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((line, index) => index > at && /^## /.test(line));
  if (end < 0) end = lines.length;
  const section = withoutMarkers(lines.slice(at + 1, end).join('\n')).trim();
  if (!section) throw new Error(`CHANGELOG.md's section for ${version} is empty`);
  return section;
}

/** The release's versions in the checkout at `root`: the workspace's (the server's), the launcher's own line, and the Python client's. */
export function releaseVersions(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const manifest = path => JSON.parse(readFileSync(join(root, path), 'utf8')).version;
  return { version: manifest('packages/serve/package.json'), launcher: manifest('packages/agentrun/package.json'), python: pythonVersionOf(readFileSync(join(root, 'python/pyproject.toml'), 'utf8')) };
}

/** The notes' install block. Every field is required. */
export function installLines({ version, launcher, python, image, platforms }) {
  for (const [name, value] of Object.entries({ version, launcher, python, image })) if (typeof value !== 'string' || !value) throw new Error(`the install lines need the ${name}`);
  if (!Array.isArray(platforms) || !platforms.length) throw new Error('the install lines need the image\'s platforms');
  return [
    '## Install',
    '',
    `- Server: \`npx @parcha/agentrun-serve@${version}\`; every \`@parcha/agentrun-*\` package of this release is ${version} on npm`,
    `- Launcher and CLI: \`npx @parcha/agentrun@${launcher}\``,
    `- Python client: \`pip install parcha-agentrun==${python}\``,
    `- Server image: \`docker pull ${image}\` (${platforms.join(', ')})`,
  ].join('\n');
}

/**
 * The body: the section, then the install block. A section that would take the body over MAX_BODY is cut after a whole line and
 * links the rest: the tag's changes/ fragments, which are what the section was folded from (the fold is not committed at the
 * tag, so CHANGELOG.md there has no section for this version).
 */
export function releaseNotes({ section, install, tag, repository }) {
  const whole = `${section}\n\n${install}\n`;
  if (whole.length <= MAX_BODY) return whole;
  const rest = `\n\nThe rest of this release's changes are in [its fragments in changes/ at ${tag}](https://github.com/${repository}/tree/${tag}/changes).\n\n${install}\n`;
  const kept = section.slice(0, MAX_BODY - rest.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${rest}`;
}

const label = /^\*\*([^*]+?):?\*\*:?\s*$/;
const cut = (line, most) => (line.length <= most ? line : `${line.slice(0, most - 1).trimEnd()}…`);

/**
 * The first lines of a section, for a post: `{ label, lines, more }`. From its upgrading or highlights block when it has one
 * ("**Upgrading and going back:**"), else from the section; the first line of each of its first `count` top-level bullets, each
 * cut at 300 characters, and how many bullets that leaves out.
 */
export function highlights(section, count = 3) {
  const lines = section.split('\n');
  const start = lines.findIndex(line => /^(?:Upgrading|Highlights)\b/i.test(label.exec(line)?.[1] ?? ''));
  let block = lines;
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && label.test(line));
    block = lines.slice(start + 1, end < 0 ? lines.length : end);
  }
  const bullets = block.filter(line => line.startsWith('- ')).map(line => cut(line.slice(2).trim(), 300));
  return { label: start >= 0 ? label.exec(lines[start])[1] : null, lines: bullets.slice(0, count), more: Math.max(0, bullets.length - count) };
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  try {
    const tag = option('--tag');
    const versions = releaseVersions();
    if (tag !== `v${versions.version}`) throw new Error(`${tag} is not this checkout's version, v${versions.version}`);
    const section = changelogSection(readFileSync(option('--changelog'), 'utf8'), versions.version);
    const install = installLines({ ...versions, image: option('--image'), platforms: (option('--platforms') ?? '').split(',').filter(Boolean) });
    writeFileSync(option('--out'), releaseNotes({ section, install, tag, repository: process.env.GITHUB_REPOSITORY ?? 'Parcha-ai/agentrun' }));
    console.log(`Wrote the notes of ${tag}: its CHANGELOG.md section (${section.split('\n').length} lines) and the install lines.`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
