// Publishes the GitHub release of a tag the release workflow has published: "AgentRun <tag>", a prerelease for a prerelease
// version, with the notes scripts/release-notes.mjs wrote. On the existing tag only: it never creates or moves one, so it stops
// when the tag is missing or names another commit than this run's, and when the tag has a release already.
//   node scripts/release-github.mjs --tag v0.1.0-beta.44 --notes <file>   (GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN; GITHUB_OUTPUT gets url=)
import { appendFileSync, readFileSync } from 'node:fs';
import { getJson } from './release-ci-gate.mjs';
import { isMain } from './is-main.mjs';
import { parseVersion } from './release-version.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The commit `tag` names, following annotated tag objects; null when the tag does not exist. */
async function tagCommit(repository, tag, read) {
  let object = (await read(`git/ref/tags/${tag}`, null))?.object ?? null;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) object = (await read(`git/tags/${object.sha}`)).object;
  if (object === null) return null;
  if (object?.type !== 'commit') throw new Error(`the tag ${tag} names a ${object?.type ?? 'missing'} object, not a commit`);
  return object.sha;
}

/** Creates the release and returns its page's URL. Every check reads before the one write, which is sent once. */
export async function publishRelease({ repository, tag, sha, notes, token, fetchImpl = fetch, wait = sleep }) {
  const version = /^v/.test(String(tag)) ? parseVersion(tag) : null;
  if (!version) throw new Error(`${JSON.stringify(tag)} is not a release tag (v<version>)`);
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
  if (typeof notes !== 'string' || !notes.trim()) throw new Error('the release notes are empty');
  const read = (path, absent) => getJson(`https://api.github.com/repos/${repository}/${path}`, { token, fetchImpl, wait, absent });
  const existing = await read(`releases/tags/${tag}`, null);
  if (existing !== null) throw new Error(`a GitHub release for ${tag} exists already: ${existing.html_url}; nothing was changed`);
  const commit = await tagCommit(repository, tag, read);
  if (commit === null) throw new Error(`the tag ${tag} does not exist; the release is published on its tag and never creates one`);
  if (commit !== sha) throw new Error(`the tag ${tag} points at ${commit}, not ${sha}, the commit this run released; the release never moves a tag`);
  const prerelease = version.pre.length > 0;
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `AgentRun ${tag}`, body: notes, draft: false, prerelease, make_latest: prerelease ? 'false' : 'true' }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errors = Array.isArray(answer.errors) ? ` (${answer.errors.map(error => [error.field, error.code].filter(Boolean).join(' ')).join(', ')})` : '';
    throw new Error(`GitHub answered ${response.status} to the release: ${answer.message ?? 'no message'}${errors}`);
  }
  return answer.html_url;
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token, GITHUB_OUTPUT: output } = process.env;
  try {
    const tag = option('--tag');
    const url = await publishRelease({ repository, tag, sha, notes: readFileSync(option('--notes'), 'utf8'), token });
    if (output) appendFileSync(output, `url=${url}\n`);
    console.log(`Published the GitHub release of ${tag}: ${url}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
