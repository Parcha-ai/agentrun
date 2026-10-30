// What two of the port's Codex patches change, pinned so that dropping one goes red by name (the patch files name these tests
// in their `Pins:` lines). The others are pinned by the adapter, pins and tool-off suites, or change comments only.
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
  assert.throws(() => codexHarness({ host: 1 }), /^TypeError: agentrun-harness-codex: the host option is gone/);
  assert.throws(() => checkConfig(5), /^TypeError: agentrun-harness-codex: config must be an object/);
  assert.throws(() => toToml({ n: Number.NaN }), /^TypeError: agentrun-harness-codex: not a TOML number/);
});
