// Opens the website's import pull request for a release, after the release workflow ran the website's own
// scripts/import-content.py in its checkout of Parcha-ai/agentrun-website main. With nothing changed, the website has the
// release already. Otherwise the change is committed as the website App's bot on release/<tag>-content, pushed, and opened as
// "content: import AgentRun <tag>" against main. A branch or an open pull request for it already there is a notice, so a re-run
// changes nothing. The App's installation token (GH_TOKEN, scoped to the website) does every write.
//   node scripts/release-website.mjs --tag v0.1.0-beta.44 --website <checkout>   (GH_TOKEN, APP_SLUG)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMain } from './is-main.mjs';
import { getJson } from './release-ci-gate.mjs';
import { parseVersion } from './release-version.mjs';

const exec = promisify(execFile);
export const WEBSITE = 'Parcha-ai/agentrun-website';

/** The import's branch for `tag`: release/<tag>-content. Throws on anything that is not a release tag. */
export function importBranch(tag) {
  if (!/^v/.test(String(tag)) || !parseVersion(tag)) throw new Error(`${JSON.stringify(tag)} is not a release tag (v<version>)`);
  return `release/${tag}-content`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Returns the one line the job prints: a ::notice:: when there is nothing to do, else the pull request opened. Throws on a failure. */
export async function openImport({ tag, dir, token, appSlug, fetchImpl = fetch, wait = sleep }) {
  const branch = importBranch(tag);
  const git = async (...args) => (await exec('git', ['-c', 'gc.auto=0', ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).stdout;
  if (!(await git('status', '--porcelain', '--untracked-files=all')).trim()) return `::notice::website already has ${tag}`;
  if ((await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).trim()) return `::notice::website import skipped: the branch ${branch} exists already; with no pull request open for it, delete the branch and re-run this job to import again`;
  const api = path => `https://api.github.com/${path}`;
  const read = path => getJson(api(path), { token, fetchImpl, wait });
  const [owner] = WEBSITE.split('/');
  const open = await read(`repos/${WEBSITE}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`);
  if (!Array.isArray(open)) throw new Error('the website\'s open pull requests could not be read');
  if (open.length) return `::notice::website import skipped: ${open[0].html_url} is open for it already`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(appSlug))) throw new Error(`not an App slug: ${JSON.stringify(appSlug)}`);
  // The App's bot commits as GitHub shows it: <slug>[bot], with the bot user's id in its noreply address.
  const bot = `${appSlug}[bot]`;
  const { id } = await read(`users/${encodeURIComponent(bot)}`);
  if (!Number.isInteger(id)) throw new Error(`the user id of ${bot} could not be read`);
  const identity = ['-c', `user.name=${bot}`, '-c', `user.email=${id}+${bot}@users.noreply.github.com`];
  const title = `content: import AgentRun ${tag}`;
  const command = `python3 scripts/import-content.py ${tag} --release-tag ${tag}`;
  await git('checkout', '-q', '-b', branch);
  await git('add', '-A');
  await git(...identity, 'commit', '-q', '-m', `${title}\n\nImported by the AgentRun release workflow: ${command}`);
  await git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  const response = await fetchImpl(api(`repos/${WEBSITE}/pulls`), {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      head: branch,
      base: 'main',
      body: `The docs and runnable examples of [AgentRun ${tag}](https://github.com/Parcha-ai/agentrun/releases/tag/${tag}), imported by the release workflow with \`${command}\`.\n`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to the pull request: ${answer.message ?? 'no message'}`);
  return `Opened ${answer.html_url}: ${title}`;
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  try {
    console.log(await openImport({ tag: option('--tag'), dir: option('--website'), token: process.env.GH_TOKEN, appSlug: process.env.APP_SLUG }));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
