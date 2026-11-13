// What AgentRun changed in the Codex harness it took from durable-harness (its own since the port froze), pinned by name:
// code mode's host on, no sub-agents, and messages that name this package.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConfig, codexConfig, toToml } from '../dist/config.js';

const base = { model: 'm', baseUrl: 'http://127.0.0.1:1/v1', envKey: 'KEY', contextWindow: 1000 };

test("the config turns code mode's host on, allows no sub-agents, and reserves the agents key", () => {
  const config = codexConfig(base);
  assert.equal(config.features.code_mode_host, true);
  // `enabled = false` (013): with it a model Codex's catalog marks multi-agent V2 gets no sub-agent tools or role message.
  assert.deepEqual(config.agents, { enabled: false, max_depth: 0 });
  assert.match(toToml(config), /\[agents\]\nenabled = false\nmax_depth = 0/);
  assert.throws(() => checkConfig({ agents: { max_depth: 3 } }), /config\.agents is set by the harness/);
});

test("the harness's messages and its model provider name this package", () => {
  assert.equal(codexConfig(base).model_providers.gateway.name, 'AgentRun model proxy');
  assert.throws(() => checkConfig(5), /^TypeError: agentrun-harness-codex: config must be an object/);
  assert.throws(() => toToml({ n: Number.NaN }), /^TypeError: agentrun-harness-codex: not a TOML number/);
});
