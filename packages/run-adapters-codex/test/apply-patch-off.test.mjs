// With the built-ins off, Codex's own apply_patch is offered to no model. Code mode (`code_mode_host`) lists it as a nested
// tool of `exec` though it has no environment to run in: every call failed "No usable execution environment is available"
// (15 dead calls in 7 of 29 benchmark runs), and Codex 0.164 has no feature that removes it. Its model catalog's
// `apply_patch_tool_type` does: the harness hands Codex its own bundled catalog (`codex debug models --bundled`) with that one
// field null for every model (`model_catalog_json`). developer-messages.test.mjs checks the pinned binary offers none.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConfig, codexConfig, MODEL_CATALOG_FILE, toToml, withoutApplyPatch } from '../dist/config.js';

const base = { model: 'gpt-6-luna', baseUrl: 'http://127.0.0.1:1/v1', envKey: 'KEY', contextWindow: 1000 };
const entry = (slug, extra = {}) => ({ slug, display_name: slug, apply_patch_tool_type: 'freeform', shell_type: 'unified_exec', tool_mode: 'code_mode_only', ...extra });

test("Codex's bundled catalog without apply_patch: that one field null on every model, everything else as Codex ships it", () => {
  const bundled = { models: [entry('gpt-6-luna', { context_window: 272000 }), entry('gpt-5.5', { tool_mode: null })], etag: 'kept' };
  const out = JSON.parse(withoutApplyPatch(JSON.stringify(bundled, null, 2)));
  assert.deepEqual(out, { models: bundled.models.map((m) => ({ ...m, apply_patch_tool_type: null })), etag: 'kept' });
  // Not a catalog: no override, Codex's own catalog stands.
  for (const text of ['', 'usage: codex …', '{}', '{"models":[]}', '{"models":[{"display_name":"x"}]}', '[1]']) assert.equal(withoutApplyPatch(text), undefined, text);
});

test('the config names the catalog Codex reads (model_catalog_json) when given one, and an app may not set it', () => {
  assert.equal(MODEL_CATALOG_FILE, 'model-catalog.json');
  assert.equal(codexConfig(base).model_catalog_json, undefined, 'no catalog given: Codex keeps its own');
  const config = codexConfig({ ...base, modelCatalog: `/vm/codex-home/${MODEL_CATALOG_FILE}` });
  assert.equal(config.model_catalog_json, '/vm/codex-home/model-catalog.json');
  assert.match(toToml(config), /^model_catalog_json = "\/vm\/codex-home\/model-catalog\.json"$/m);
  assert.throws(() => checkConfig({ model_catalog_json: '/tmp/mine.json' }), /config\.model_catalog_json is set by the harness/);
});
