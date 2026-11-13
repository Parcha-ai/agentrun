// With the built-ins off, Codex's own apply_patch is offered to no model. Code mode (`code_mode_host`) lists it as a nested
// tool of `exec` though it has no environment to run in: every call failed "No usable execution environment is available"
// (15 dead calls in 7 of 29 benchmark runs), and Codex 0.164 has no feature that removes it. Its model catalog's
// `apply_patch_tool_type` does: the session's machine hands Codex its own bundled catalog (`codex debug models --bundled`)
// with that one field null for every model (`model_catalog_json`). developer-messages.test.mjs checks the pinned binary,
// through the adapter, offers none. A binary that gives no catalog is never silent: the machine's notes say why.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MODEL_CATALOG_FILE, patchlessCatalog, withoutApplyPatch } from '../dist/catalog.js';
import { checkConfig } from '../dist/config.js';
import { localMachine } from '../dist/host/machine.js';
import { CODEX_ROUTES, gatewayHandler } from '../dist/host/process.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-catalog-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

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
  const bin = { command: '/opt/codex-a' };
  const read = await patchlessCatalog(c.spawn, bin, dirs, new AbortController().signal);
  assert.deepEqual(c.spawned.map((s) => [s.command, ...s.args]), [['/opt/codex-a', 'debug', 'models', '--bundled']]);
  assert.deepEqual([c.spawned[0].env.CODEX_HOME, c.spawned[0].cwd], ['/vm/cache/codex-catalog', '/vm/cache/codex-catalog'], "not the session's CODEX_HOME");
  assert.equal(read.why, undefined);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(read.bytes)).models.map((x) => [x.slug, x.apply_patch_tool_type]), [['gpt-6-luna', null], ['gpt-6-sol', null]]);
  // The same binary again: its catalog, not a second read.
  assert.equal((await patchlessCatalog(c.spawn, bin, dirs, new AbortController().signal)).bytes, read.bytes);
  assert.equal(c.spawned.length, 1);
  assert.throws(() => checkConfig({ model_catalog_json: '/tmp/mine.json' }), /config\.model_catalog_json is set by the harness/);
});

test("a binary that gives no catalog gives a reason instead, never silence; it is not remembered, so the next drive tries again", async () => {
  const c = codex('usage: codex app-server --stdio', 2);
  const read = await patchlessCatalog(c.spawn, { command: '/opt/codex-b' }, dirs, new AbortController().signal);
  assert.equal(read.bytes, undefined);
  assert.match(read.why, /^Codex's own apply_patch stays listed: its bundled model catalog could not be read \(exit code 2: error: unknown subcommand\)/);
  await patchlessCatalog(c.spawn, { command: '/opt/codex-b' }, dirs, new AbortController().signal);
  assert.equal(c.spawned.length, 2);
});

const route = { routes: CODEX_ROUTES, models: { model: 'luna-test' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
const hooks = { beforeRequest: async () => {}, afterRequest: async () => {} };
/** A stand-in binary in `dir`: `script` is its shell body. */
const binaryIn = (dir, script) => {
  const path = join(dir, 'codex-stub');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
};

test("on the machine: a binary that fails --bundled leaves Codex's catalog and config alone, and the machine's notes say why", async () => {
  const dir = scratch();
  const command = binaryIn(dir, 'echo "error: unexpected argument --bundled" >&2; exit 2');
  const machine = await localMachine({ dir: join(dir, 'session'), env: { PATH: process.env.PATH }, proxy: { hooks, tools: [] }, catalog: { command } })({ ctx: { runId: 'r1' }, model: gatewayHandler(route) });
  try {
    assert.equal(machine.notes.length, 1, JSON.stringify(machine.notes));
    assert.match(machine.notes[0], /^Codex's own apply_patch stays listed: its bundled model catalog could not be read \(exit code 2: error: unexpected argument --bundled\)/);
    assert.match(machine.notes[0], /no environment to run in/);
    const config = { features: {} };
    machine.configure?.(config);
    assert.equal(config.model_catalog_json, undefined);
    assert.equal(existsSync(join(machine.dirs['codex-home'], MODEL_CATALOG_FILE)), false);
  } finally {
    await machine.close();
  }
});

test("on the machine: a binary that gives its catalog has no note, and Codex's config names the catalog in codex-home", async () => {
  const dir = scratch();
  const catalog = join(dir, 'bundled.json');
  writeFileSync(catalog, JSON.stringify({ models: [entry('luna-test')] }, null, 2));
  const command = binaryIn(dir, `[ "$1 $2 $3" = "debug models --bundled" ] || exit 9; cat '${catalog}'`);
  const machine = await localMachine({ dir: join(dir, 'session'), env: { PATH: process.env.PATH }, proxy: { hooks, tools: [] }, catalog: { command } })({ ctx: { runId: 'r2' }, model: gatewayHandler(route) });
  try {
    assert.deepEqual(machine.notes, []);
    const config = { features: {} };
    machine.configure?.(config);
    assert.equal(config.model_catalog_json, join(machine.dirs['codex-home'], MODEL_CATALOG_FILE));
    assert.deepEqual(JSON.parse(readFileSync(config.model_catalog_json, 'utf8')).models.map((m) => m.apply_patch_tool_type), [null]);
  } finally {
    await machine.close();
  }
});

test("a catalog that can't be read is said with the binary's name only: no host path, and no CODEX_HOME of its own", async () => {
  const bin = { command: '/opt/secret-place/bin/codex-b' };
  // It doesn't start: the spawn's error names the binary by its full path.
  const notStarted = await patchlessCatalog(async () => { throw new Error('spawn /opt/secret-place/bin/codex-b ENOENT'); }, bin, dirs, new AbortController().signal);
  assert.match(notStarted.why ?? '', /codex-b/, `it names the binary: ${notStarted.why}`);
  assert.doesNotMatch(notStarted.why ?? '', /\/opt\/secret-place/, `no host path: ${notStarted.why}`);
  // It fails: its stderr names its own CODEX_HOME.
  const spawn = async () => ({ end() {}, kill() {}, async *lines() {}, exited: Promise.resolve({ code: 2, signal: null }), stderrTail: () => `error: cannot write ${dirs.own}/models.json under ${dirs.home}` });
  const failed = await patchlessCatalog(spawn, { command: '/opt/secret-place/bin/codex-c' }, dirs, new AbortController().signal);
  assert.match(failed.why ?? '', /exit code 2/, `it says how it failed: ${failed.why}`);
  for (const path of [dirs.own, dirs.home, '/opt/secret-place']) assert.ok(!(failed.why ?? '').includes(path), `no ${path} in: ${failed.why}`);
});
