// The live session's parts, offline: what the person says, and that the tools the agent is told about are the tools the workflow calls and the live code provides.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { githubTools } from './issue-triage/github.ts';
import { sentenceFor, TOOLS } from './issue-triage/session.ts';

const workflow = JSON.parse(readFileSync(new URL('./issue-triage/workflow.json', import.meta.url), 'utf8'));
const callTools = (node, found = new Set()) => {
  if (Array.isArray(node)) node.forEach((each) => callTools(each, found));
  else if (node && typeof node === 'object') { if (node.node === 'call' && node.via === 'tool') found.add(node.tool); Object.values(node).forEach((each) => callTools(each, found)); }
  return found;
};

test('the sentence names the issues, the commit the code is read at and the maintainers\' labels, and no kill', () => {
  const sentence = sentenceFor({ repo: 'o/r', sha: 'a'.repeat(40), numbers: [3, 5], label_map: { enhancement: 'feature', bug: 'bug' } });
  assert.match(sentence, /o\/r issues #3, #5/);
  assert.match(sentence, new RegExp(`commit ${'a'.repeat(40)}`));
  assert.match(sentence, /"enhancement" counts as feature/);
  assert.doesNotMatch(sentence, /kill|restart/i);
});

test('every tool the workflow calls is told to the agent and provided by the live GitHub tools', () => {
  const told = new Set(TOOLS.map((tool) => tool.name));
  const provided = new Set(Object.keys(githubTools({})));
  for (const name of callTools(workflow)) { assert.ok(told.has(name), `${name} is described to the agent`); assert.ok(provided.has(name), `${name} is provided live`); }
  assert.deepEqual(TOOLS.find((tool) => tool.name === 'github_code').parameters.required, ['repo', 'number', 'sha']);
});

test('the research node reads and nothing else: its declared tools are the read tool alone', () => {
  const agents = [];
  (function walk(node) { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { if (node.node === 'agent') agents.push(node); Object.values(node).forEach(walk); } })(workflow);
  assert.ok(agents.length >= 1);
  for (const agent of agents) assert.deepEqual(agent.tools, ['read']);
});
