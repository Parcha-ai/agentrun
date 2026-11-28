import { readFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';
import { getJson } from './release-ci-gate.mjs';

const starStep = 100;
const firstMilestone = 1300;
const starTask = 'community:discord-stars';
const starEnvironment = 'Discord star milestones';
const formatCount = new Intl.NumberFormat('en-US');

export function releaseEmbed({ tag, url, notes }) {
  if (!/^https:\/\/github\.com\/Parcha-ai\/agentrun\/releases\/tag\/v[\w.-]+$/.test(url) || !url.endsWith(`/${tag}`)) {
    throw new Error('The published AgentRun release URL does not match its tag.');
  }
  const [intro, upgrade] = notes.replace(/<!--[^]*?-->/g, '').trim()
    .split(/^\*\*Upgrading and going back:\*\*\s*$/m);
  const summary = intro.split(/\n\s*\n/, 1)[0].replace(/\s+/g, ' ').trim();
  const upgradeLine = upgrade?.match(/^- (.+)$/m)?.[1];
  return {
    title: `AgentRun ${tag}`,
    url,
    color: 0x5865f2,
    description: [summary.length <= 1200 ? summary : '', `[Read the full release notes and install instructions](${url})`]
      .filter(Boolean).join('\n\n'),
    fields: upgradeLine?.length <= 1024 ? [{ name: 'Before you upgrade', value: upgradeLine }] : [],
    footer: { text: tag.includes('-') ? 'GitHub prerelease' : 'GitHub release' },
  };
}

function webhook(raw) {
  const value = raw?.trim() ?? '';
  if (!/^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(value)) {
    throw new Error('Expected a Discord webhook URL in the Actions secret.');
  }
  return value;
}

export async function discordRequest(raw, embed, fetchImpl = fetch) {
  const url = webhook(raw);
  const posting = Boolean(embed);
  const request = posting ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  } : { method: 'GET' };

  let response;
  try {
    response = await fetchImpl(posting ? `${url}?wait=true` : url, {
      ...request, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(posting ? 'Discord delivery is unconfirmed. Check the channel before retrying.' : 'Discord could not be reached.');
  }
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}.`);
  const result = await response.json().catch(() => null);
  if (!result?.id || !result.channel_id) throw new Error('Discord did not return a delivery receipt.');
  return { id: result.id, channelId: result.channel_id, guildId: result.guild_id };
}

export async function notifyStars({ repository, sha, token, webhookUrl, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repository}`;
  const read = url => getJson(url, { token, fetchImpl });
  const { stargazers_count: stars } = await read(base);
  if (!Number.isSafeInteger(stars) || stars < 0) throw new Error('GitHub did not return a valid star count.');

  const milestone = Math.floor(stars / starStep) * starStep;
  if (milestone < firstMilestone) return null;

  const query = new URLSearchParams({ task: starTask, environment: starEnvironment, per_page: '1' });
  const [latest] = await read(`${base}/deployments?${query}`);
  if (latest && !Number.isSafeInteger(latest.payload?.milestone)) throw new Error('Invalid Discord milestone record.');
  if (latest?.payload.milestone >= milestone) return null;

  // Reserve the milestone before contacting Discord. A timeout or interrupted run cannot trigger a second post.
  // Deployment records are durable and require no token with permission to write repository contents.
  webhook(webhookUrl);
  const write = (path, data) => fetchImpl(`${base}/deployments${path}`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(20_000),
  });
  const reserve = await write('', {
    ref: sha, task: starTask, environment: starEnvironment, production_environment: false,
    auto_merge: false, required_contexts: [], payload: { milestone },
    description: `Reserve the ${formatCount.format(milestone)}-star Discord announcement`,
  });
  if (reserve.status !== 201) throw new Error(`GitHub returned HTTP ${reserve.status} when reserving the Discord milestone.`);
  const { id: deploymentId } = await reserve.json();
  if (!Number.isSafeInteger(deploymentId)) throw new Error('GitHub did not return the milestone record ID.');

  const result = await discordRequest(webhookUrl, {
    title: `⭐ AgentRun passed ${formatCount.format(milestone)} GitHub stars`,
    url: `https://github.com/${repository}`,
    color: 0xf7bd45,
    description: 'Thanks to everyone starring AgentRun, filing issues, and sharing what they build.',
    fields: [{ name: 'GitHub stars', value: formatCount.format(stars), inline: true }],
    footer: { text: 'AgentRun community' },
  }, fetchImpl);
  const recorded = await write(`/${deploymentId}/statuses`, {
    state: 'success', description: `Discord message ${result.id}`, auto_inactive: false,
  });
  if (recorded.status !== 201) {
    throw new Error(`Discord received message ${result.id}. GitHub returned HTTP ${recorded.status} when recording delivery.`);
  }
  return result.id;
}

if (isMain(import.meta)) {
  const [mode, first, second, third] = process.argv.slice(2);
  const { DISCORD_WEBHOOK_URL: url, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  try {
    if (mode === 'release') {
      if (url) {
        const receipt = await discordRequest(url, releaseEmbed({ tag: first, notes: readFileSync(second, 'utf8'), url: third }));
        console.log(`Posted release ${first} to Discord (message ${receipt.id}).`);
      } else {
        console.log('::notice::Discord release notification skipped: DISCORD_RELEASES_WEBHOOK_URL is unset.');
      }
    } else if (mode === 'stars') {
      const messageId = await notifyStars({ repository, sha, token, webhookUrl: url });
      console.log(messageId ? `Posted Discord star milestone (message ${messageId}).` : 'No new star milestone.');
    } else if (mode === 'verify') {
      const { guildId, channelId } = await discordRequest(url);
      if (guildId !== first || channelId !== second) throw new Error('Webhook points to an unexpected Discord channel.');
      console.log('Discord webhook verified in the expected channel.');
    } else {
      throw new Error('Expected release, stars or verify.');
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
