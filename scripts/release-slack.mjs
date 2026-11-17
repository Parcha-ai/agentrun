// Posts a published release to Slack, through the path the star notifications use (stars-to-slack.yml): the bot token in the
// secret SLACK_STARS_BOT_TOKEN, chat.postMessage, and here the channel in the repository variable SLACK_RELEASES_CHANNEL. The post
// is the version, the release's URL, and the first lines of its upgrading block (or of its changes). It never fails the release:
// an unset setting is one line, and a failed post a warning; the command always exits 0.
//   node scripts/release-slack.mjs --tag v0.1.0-beta.44 --url <release url> --changelog <folded CHANGELOG.md>   (SLACK_BOT_TOKEN, SLACK_CHANNEL)
import { readFile } from 'node:fs/promises';
import { isMain } from './is-main.mjs';
import { changelogSection, highlights } from './release-notes.mjs';

export const SLACK_ENDPOINT = 'https://slack.com/api/chat.postMessage';

// Slack's mrkdwn reads &, < and > as markup; a changelog's **bold** is Slack's *bold*.
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*([^*]+)\*\*/g, '*$1*');

/** The post's text, from the folded changelog's text. */
export function releasePost({ tag, url, changelog }) {
  const { label, lines, more } = highlights(changelogSection(changelog, tag.replace(/^v/, '')));
  return [
    `*AgentRun ${tag}* is out: <${url}|release notes>`,
    ...(label ? [`*${escape(label)}:*`] : []),
    ...lines.map(line => `• ${escape(line)}`),
    ...(more ? [`…and ${more} more in the notes.`] : []),
  ].join('\n');
}

/** Posts it and returns the one line the job prints; never throws. `endpoint` is Slack's, or a local stand-in in the tests. */
export async function announce({ env, tag, url, changelog, endpoint = SLACK_ENDPOINT, fetchImpl = fetch }) {
  const token = (env.SLACK_BOT_TOKEN ?? '').trim();
  const channel = (env.SLACK_CHANNEL ?? '').trim();
  const missing = [...(token ? [] : ['the secret SLACK_STARS_BOT_TOKEN']), ...(channel ? [] : ['the repository variable SLACK_RELEASES_CHANNEL'])];
  if (missing.length) return `Not posted to Slack: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} unset. The release is published.`;
  const failed = why => `::warning::The release is published; posting it to Slack failed: ${why}.`;
  let text;
  try { text = releasePost({ tag, url, changelog: await readFile(changelog, 'utf8') }); } catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return failed('Slack could not be reached');
  }
  if (!response.ok) return failed(`Slack answered HTTP ${response.status}`);
  const result = await response.json().catch(() => ({}));
  if (result.ok !== true) return failed(`Slack refused it: ${typeof result.error === 'string' ? result.error : 'unknown_error'}`);
  return `Posted ${tag} to Slack.`;
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  console.log(await announce({ env: process.env, tag: option('--tag') ?? '', url: option('--url') ?? '', changelog: option('--changelog') ?? '' }).catch(error => `::warning::The release is published; posting it to Slack failed: ${error instanceof Error ? error.message : String(error)}.`));
  process.exitCode = 0;
}
