// What three of the port's Codex patches change, pinned so that dropping one goes red by name (the patch files name these
// tests in their `Pins:` lines). The others are pinned by the adapter, pins, tool-off and web-search suites, or change
// comments only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConfig, codexConfig, toToml } from '../dist/config.js';
import { codexHarness } from '../dist/harness.js';

const base = { model: 'm', baseUrl: 'http://127.0.0.1:1/v1', envKey: 'KEY', contextWindow: 1000 };

test("the config turns code mode's host on, allows no sub-agents, and reserves the agents key", () => {
  const config = codexConfig(base);
  assert.equal(config.features.code_mode_host, true);
  assert.deepEqual(config.agents, { max_depth: 0 });
  assert.match(toToml(config), /\[agents\]\nmax_depth = 0/);
  assert.throws(() => checkConfig({ agents: { max_depth: 3 } }), /config\.agents is set by the harness/);
});

test("the harness's messages and its model provider name this package", () => {
  assert.equal(codexConfig(base).model_providers.gateway.name, 'AgentRun model proxy');
  assert.throws(() => codexHarness({ host: 1 }), /^TypeError: agentrun-codex: the host option is gone/);
  assert.throws(() => checkConfig(5), /^TypeError: agentrun-codex: config must be an object/);
  assert.throws(() => toToml({ n: Number.NaN }), /^TypeError: agentrun-codex: not a TOML number/);
});

test('the config sets Codex\'s web search to live only when asked, and a caller still may not set web_search itself', () => {
  const off = codexConfig(base);
  const on = codexConfig({ ...base, webSearch: 'live' });
  assert.equal(off.web_search, 'disabled');
  assert.equal(on.web_search, 'live');
  // Off is the config as it was; on differs by that one line, and the session's provider needs no capability for it.
  assert.equal(toToml(codexConfig({ ...base, webSearch: undefined })), toToml(off));
  assert.equal(toToml(on), toToml(off).replace('web_search = "disabled"\n', 'web_search = "live"\n'));
  assert.notEqual(toToml(on), toToml(off));
  for (const config of [{ web_search: 'live' }, { tools: { web_search: true } }, { 'tools.web_search': true }]) {
    assert.throws(() => checkConfig(config), /config\.(tools\.)?web_search is set by the harness/, JSON.stringify(config));
  }
});
