// With the built-ins off, Codex's own apply_patch is offered to no model. Code mode (`code_mode_host`) lists it as a nested
// tool of `exec` though it has no environment to run in: every call failed "No usable execution environment is available"
// (15 dead calls in 7 of 29 benchmark runs), and Codex 0.164 has no feature that removes it. Its model catalog's
// `apply_patch_tool_type` does: the session's machine hands Codex its own bundled catalog (`codex debug models --bundled`)
// with that one field null for every model (`model_catalog_json`). developer-messages.test.mjs checks the pinned binary,
// through the adapter, offers none.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CATALOG_FILE, patchlessCatalog, withoutApplyPatch } from '../dist/catalog.js';
import { checkConfig } from '../dist/config.js';

const entry = (slug, extra = {}) => ({ slug, display_name: slug, apply_patch_tool_type: 'freeform', shell_type: 'unified_exec', tool_mode: 'code_mode_only', ...extra });
const dirs = { home: '/vm/home', tmp: '/vm/tmp', own: '/vm/cache/codex-catalog' };

test("Codex's bundled catalog without apply_patch: that one field null on every model, everything else as Codex ships it", () => {
  const bundled = { models: [entry('gpt-6-luna', { context_window: 272000 }), entry('gpt-5.5', { tool_mode: null })], etag: 'kept' };
  const out = JSON.parse(withoutApplyPatch(JSON.stringify(bundled, null, 2)));
  assert.deepEqual(out, { models: bundled.models.map((m) => ({ ...m, apply_patch_tool_type: null })), etag: 'kept' });
  // Not a catalog: no override, Codex's own catalog stands.
  for (const text of ['', 'usage: codex …', '{}', '{"models":[]}', '{"models":[{"display_name":"x"}]}', '[1]']) assert.equal(withoutApplyPatch(text), undefined, text);
});

/** A spawn whose Codex prints `stdout` and exits `code`: each start it was asked for. */
function codex(stdout, code = 0) {
  const spawned = [];
  const spawn = async (options) => {
    spawned.push(options);
    return {
      end() {},
      kill() {},
      async *lines() {
        yield* stdout.split('\n');
      },
      exited: Promise.resolve({ code, signal: null }),
      stderrTail: () => (code ? 'error: unknown subcommand' : ''),
    };
  };
  return { spawn, spawned };
}

test("the catalog is read from the session's own binary, in a CODEX_HOME of its own, once per binary; the config key is the harness's", async () => {
  assert.equal(MODEL_CATALOG_FILE, 'model-catalog.json');
  const bundled = JSON.stringify({ models: [entry('gpt-6-luna'), entry('gpt-6-sol')] }, null, 2);
  const c = codex(bundled);
  const logged = [];
  const bin = { command: '/opt/codex-a', log: (msg) => logged.push(msg) };
  const bytes = await patchlessCatalog(c.spawn, bin, dirs, new AbortController().signal);
  assert.deepEqual(c.spawned.map((s) => [s.command, ...s.args]), [['/opt/codex-a', 'debug', 'models', '--bundled']]);
  assert.deepEqual([c.spawned[0].env.CODEX_HOME, c.spawned[0].cwd], ['/vm/cache/codex-catalog', '/vm/cache/codex-catalog'], "not the session's CODEX_HOME");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).models.map((x) => [x.slug, x.apply_patch_tool_type]), [['gpt-6-luna', null], ['gpt-6-sol', null]]);
  assert.deepEqual(logged, []);
  // The same binary again: its catalog, not a second read.
  assert.equal(await patchlessCatalog(c.spawn, bin, dirs, new AbortController().signal), bytes);
  assert.equal(c.spawned.length, 1);
  assert.throws(() => checkConfig({ model_catalog_json: '/tmp/mine.json' }), /config\.model_catalog_json is set by the harness/);
});

test("a binary that gives no catalog gives none, and says so in the log: the session runs on Codex's own", async () => {
  const c = codex('usage: codex app-server --stdio', 2);
  const logged = [];
  assert.equal(await patchlessCatalog(c.spawn, { command: '/opt/codex-b', log: (msg) => logged.push(msg) }, dirs, new AbortController().signal), undefined);
  assert.match(logged.join('\n'), /bundled model catalog could not be read/);
  // Not remembered: the next drive tries again.
  await patchlessCatalog(c.spawn, { command: '/opt/codex-b' }, dirs, new AbortController().signal);
  assert.equal(c.spawned.length, 2);
});
