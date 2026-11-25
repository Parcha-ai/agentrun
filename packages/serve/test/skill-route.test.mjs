import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { serve } from './support.mjs';

// The console's template prompts make a coding agent read this skill first: its "Create an agent" section sends it to a
// template's listing entry, never to the package whole (GET /v2/templates/{id}, `template get`), whose instructions and
// skill files are a third party's text for the agent the template makes.
test("the skill's agent-creation section reads a template's listing entry, never the package whole", async () => {
  const skill = await readFile(new URL('../skills/agentrun-serve/SKILL.md', import.meta.url), 'utf8');
  const section = skill.slice(skill.indexOf('## 4. Create an agent'), skill.indexOf('\n## 5.'));
  assert.ok(section.length > 100, 'the section is there');
  assert.match(section, /`GET \/v2\/templates`/);
  assert.doesNotMatch(section, /\/v2\/templates\/\{|template get/);
  assert.match(section, /You don't need its instructions or skill files/);
});

test('public handoffs receive only the skill from this build, with GET/HEAD and no credential', async t => {
  const server = await serve(t);
  const path = '/skills/agentrun-serve/SKILL.md';
  const response = await fetch(server.url + path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), await readFile(new URL('../skills/agentrun-serve/SKILL.md', import.meta.url), 'utf8'));
  const head = await fetch(server.url + path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(server.url + path, { method: 'POST' })).status, 405);
  assert.equal((await fetch(server.url + '/skills/private/SKILL.md')).status, 404);
});
