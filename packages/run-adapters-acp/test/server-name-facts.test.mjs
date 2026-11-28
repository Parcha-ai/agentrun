// How a host reads our tools' names back from what the agent calls them, under a server name of the run's own (`ar` and
// 6 hex digits, calls.ts mcpServerName) as under `agentrun`: exactly that form and nothing near it. The facts are the
// adapter's, the same for every run, so they read any name of that form; which one is this run's is the proxy's policy
// (a proxy-billed recipe: only `<this start's name>__<tool>` reaches the model) and the title tie's (rt.server).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorFacts, gooseFacts } from '@parcha/agentrun-harness-acp';

test("Goose's facts (and a proxy-billed recipe's, which takes them) read a tool named under a run's own server name as ours: ar3f12ab__look_up is look_up", () => {
  // Before: only `agentrun__` was stripped, so a proxy-billed tie recipe's meta tools_call said there was no such tool.
  assert.equal(gooseFacts.hostName('ar3f12ab__look_up'), 'look_up');
  assert.equal(gooseFacts.hostName('agentrun__look_up'), 'look_up');
  assert.equal(gooseFacts.hostName('agentrun__a__b'), 'a__b', 'a tool whose own name holds __ keeps it');
  for (const other of ['ar3f12a__look_up', 'ar3f12abc__look_up', 'ar3F12AB__look_up', 'xar3f12ab__look_up', 'ar3f12ab_look_up', 'github__look_up', 'look_up']) assert.equal(gooseFacts.hostName(other), other, other);
});

test("Cursor's facts read a title as ours only under ar and exactly 6 lowercase hex digits", () => {
  assert.equal(cursorFacts.hostName('ar3f12ab-look_up: look_up'), 'look_up');
  assert.equal(cursorFacts.hostName('ar3f12ab: look_up'), 'look_up');
  for (const other of ['ar3f12a-look_up: look_up', 'ar3f12abc-look_up: look_up', 'AR3F12AB: look_up', 'xar3f12ab: look_up', 'agentrun: look_up', 'Run ls']) assert.equal(cursorFacts.hostName(other), other, other);
});
