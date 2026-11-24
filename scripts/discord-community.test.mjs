import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordRequest, notifyStars, releaseEmbed } from './discord-community.mjs';

const repository = 'Parcha-ai/agentrun';
const repoUrl = `https://api.github.com/repos/${repository}`;
const webhookUrl = ['https://discord.com/api/webhooks', '42', 'test-key'].join('/');
const tag = 'v0.1.0-beta.56';
const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;

test('release card includes the source summary and first upgrade note with the full release link', () => {
  const notes = 'New runner controls.\n\n**Upgrading and going back:**\n\n- The store stays at version 15.\n\n## Install\n';
  const embed = releaseEmbed({ tag, url: releaseUrl, notes });
  assert.equal(embed.title, `AgentRun ${tag}`);
  assert.equal(embed.url, releaseUrl);
  assert.match(embed.description, /^New runner controls\./);
  assert.ok(embed.description.includes(releaseUrl));
  assert.deepEqual(embed.fields, [{ name: 'Before you upgrade', value: 'The store stays at version 15.' }]);
  assert.equal(embed.footer.text, 'GitHub prerelease');
  assert.throws(() => releaseEmbed({ tag, notes, url: '' }), /does not match/);
});

test('Discord sends an embed without pings and keeps the URL out of transport errors', async () => {
  const embed = { title: 'Release', description: '@everyone' };
  const receipt = await discordRequest(webhookUrl, embed, async (url, request) => {
    assert.equal(url, `${webhookUrl}?wait=true`);
    assert.equal(request.redirect, 'error');
    assert.deepEqual(JSON.parse(request.body), { embeds: [embed], allowed_mentions: { parse: [] } });
    return Response.json({ id: '12', channel_id: '34' });
  });
  assert.equal(receipt.id, '12');
  await assert.rejects(discordRequest(webhookUrl, embed, async () => { throw new Error(webhookUrl); }), {
    message: 'Discord delivery is unconfirmed. Check the channel before retrying.',
  });
});

test('a late poll announces the highest new milestone once, including after an unstar and restar', async () => {
  let stars = 1499;
  let deployment;
  const outgoing = [];
  const fetchImpl = async (url, request) => {
    if (url === repoUrl) return Response.json({ stargazers_count: stars });
    if (url.startsWith(`${repoUrl}/deployments?`)) return Response.json(deployment ? [deployment] : []);
    if (url === `${repoUrl}/deployments`) {
      const data = JSON.parse(request.body);
      assert.equal(data.auto_merge, false);
      deployment = { id: 123, payload: data.payload };
      return Response.json(deployment, { status: 201 });
    }
    if (url === `${repoUrl}/deployments/123/statuses`) {
      assert.equal(JSON.parse(request.body).description, 'Discord message 12');
      return Response.json({}, { status: 201 });
    }
    assert.equal(url, `${webhookUrl}?wait=true`);
    outgoing.push(JSON.parse(request.body).embeds[0]);
    assert.equal(deployment.payload.milestone, 1500, 'the record exists before delivery');
    return Response.json({ id: '12', channel_id: '34' });
  };
  const check = () => notifyStars({ repository, sha: 'a'.repeat(40), token: 'test', webhookUrl, fetchImpl });
  assert.equal(await check(), null);
  stars = 1503;
  assert.equal(await check(), '12');
  stars = 1499;
  assert.equal(await check(), null);
  stars = 1500;
  assert.equal(await check(), null);
  assert.deepEqual(outgoing.map(embed => [embed.title, embed.fields[0].value]), [
    ['⭐ AgentRun passed 1,500 GitHub stars', '1,503'],
  ]);
});

test('a Discord timeout keeps the reservation and does not replay the announcement', async () => {
  let deployment;
  let posts = 0;
  const fetchImpl = async (url, request) => {
    if (url === repoUrl) return Response.json({ stargazers_count: 2010 });
    if (url.startsWith(`${repoUrl}/deployments?`)) return Response.json(deployment ? [deployment] : []);
    if (url === `${repoUrl}/deployments`) {
      deployment = { id: 123, payload: JSON.parse(request.body).payload };
      return Response.json(deployment, { status: 201 });
    }
    assert.equal(url, `${webhookUrl}?wait=true`);
    posts += 1;
    throw new Error('timeout waiting for Discord');
  };
  const check = () => notifyStars({ repository, sha: 'a'.repeat(40), token: 'test', webhookUrl, fetchImpl });
  await assert.rejects(check(), /delivery is unconfirmed/);
  assert.equal(deployment.payload.milestone, 2000);
  assert.equal(await check(), null);
  assert.equal(posts, 1);
});
