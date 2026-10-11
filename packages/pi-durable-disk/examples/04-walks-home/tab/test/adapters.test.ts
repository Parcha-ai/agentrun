import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AdapterError, assertPinnedWllama, installedVersions, loadWithAdapters, PINNED_LIBLLAMA, PINNED_WLLAMA, selection, type WllamaLike } from '../src/adapters.ts';

const PINNED = { wllama: PINNED_WLLAMA, libllama: PINNED_LIBLLAMA };
type ModelFile = { name: string; blob: Blob };

/** wllama 3.6.1's loadModel, as far as the hook depends on it: the worker proxy is assigned, an await (preparing the blobs), then
 *  moduleInit gets the model's shards; the native load then opens every lora path, and fails on one that is not a file it was given. */
function fakeWllama(o: { field?: string; checkPaths?: boolean } = {}) {
  const loads: { files: string[]; params: Record<string, any> }[] = [];
  const w = {
    proxy: null as unknown,
    loads,
    async loadModel(blobs: Blob[], params: Record<string, any> = {}) {
      let got: ModelFile[] = [];
      const proxy = { async moduleInit(files: ModelFile[]) { got = files; } };
      (w as any)[o.field ?? 'proxy'] = proxy;
      await Promise.resolve();
      const shards = blobs.map((blob, i) => ({ name: `model-${String(i + 1).padStart(5, '0')}-of-${String(blobs.length).padStart(5, '0')}.gguf`, blob }));
      await ((w as any)[o.field ?? 'proxy'] as typeof proxy).moduleInit(shards);
      if (o.checkPaths !== false) {
        for (const a of params.lora_adapters ?? []) if (!got.some((f) => `models/${f.name}` === a.path)) throw new Error(`llama_adapter_lora_init: failed to open ${a.path}`);
      }
      loads.push({ files: got.map((f) => f.name), params });
    },
  };
  return w;
}
const blob = (n = 8) => new Blob([new Uint8Array(n)]);

test('the pin: only wllama 3.6.1 with its own llama.cpp build is accepted, and this checkout installs exactly that', () => {
  assert.deepEqual(installedVersions(), PINNED, 'package.json or node_modules moved off the pin');
  assertPinnedWllama(PINNED);
  assert.throws(() => assertPinnedWllama({ wllama: '3.7.0', libllama: PINNED_LIBLLAMA }), (e: unknown) => e instanceof AdapterError && /3\.7\.0 .* is not the pinned 3\.6\.1/.test((e as Error).message) && /proxy\.moduleInit/.test((e as Error).message));
  assert.throws(() => assertPinnedWllama({ wllama: PINNED_WLLAMA, libllama: 'b10999-0000000' }), AdapterError);
});

test("the installed wllama still has the hook point: loadModel assigns this.proxy before it hands the model's files to proxy.moduleInit", () => {
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve('@wllama/wllama/esm/index.js'), 'utf8');
  const at = src.indexOf('function* (ggufBlobsOrModel, params');
  assert.ok(at > 0, 'loadModel(ggufBlobsOrModel, params) is gone from the bundle');
  const load = src.slice(at);
  const assign = load.indexOf('this.proxy = new ProxyToWorker(');
  const init = load.indexOf('this.proxy.moduleInit(modelFiles.all)');
  assert.ok(assign > 0 && init > assign, 'wllama changed how loadModel creates its worker proxy: the adapter hook needs a look');
  assert.match(load, /lora_paths: \(_\w+ = params\.lora_adapters\) == null \? void 0 : _\w+\.map\(\(a\) => a\.path\)/, 'lora_adapters still becomes the native lora_paths');
});

test('the adapters go into wllama\'s filesystem beside the shards, all at scale 0, ids in the order given; the proxy is a plain field again after', async () => {
  const w = fakeWllama();
  const loaded = await loadWithAdapters(w, [blob()], [{ name: 'tools.gguf', blob: blob(4) }, { name: 'moon.gguf', blob: blob(4) }], { n_ctx: 2048, swa_full: true }, PINNED);
  assert.deepEqual(w.loads[0]!.files, ['model-00001-of-00001.gguf', 'tools.gguf', 'moon.gguf']);
  assert.deepEqual(w.loads[0]!.params.lora_adapters, [{ path: 'models/tools.gguf', scale: 0 }, { path: 'models/moon.gguf', scale: 0 }]);
  assert.equal(w.loads[0]!.params.swa_full, true, 'the caller\'s load parameters pass through');
  assert.deepEqual(loaded.names, ['tools.gguf', 'moon.gguf']);
  const d = Object.getOwnPropertyDescriptor(w, 'proxy')!;
  assert.ok('value' in d && d.writable && d.value !== null, 'the proxy is a plain field holding wllama\'s own proxy again');
  assert.deepEqual(loaded.select({}), [{ id: 0, scale: 0 }, { id: 1, scale: 0 }], 'no selection: the base');
  assert.deepEqual(loaded.select({ 'moon.gguf': 1 }), [{ id: 0, scale: 0 }, { id: 1, scale: 1 }]);
  assert.deepEqual(loaded.select({ 'tools.gguf': 1, 'moon.gguf': 0.5 }), [{ id: 0, scale: 1 }, { id: 1, scale: 0.5 }]);
});

test('a selection names loaded adapters only, at a scale in 0..4', () => {
  const names = ['tools.gguf'];
  assert.throws(() => selection(names, { 'moon.gguf': 1 }), /no adapter named "moon\.gguf" is loaded \(loaded: tools\.gguf\)/);
  for (const s of [-1, 5, Number.NaN, Infinity]) assert.throws(() => selection(names, { 'tools.gguf': s }), AdapterError, String(s));
});

test('without adapters it is a plain load: no hook, no lora_adapters', async () => {
  const w = fakeWllama();
  const loaded = await loadWithAdapters(w, [blob()], [], { n_ctx: 512 }, PINNED);
  assert.deepEqual(w.loads[0], { files: ['model-00001-of-00001.gguf'], params: { n_ctx: 512 } });
  assert.deepEqual(loaded.select({}), []);
});

test('a wllama whose internals moved is refused loudly: the hook never ran, whether its load failed or not', async () => {
  await assert.rejects(loadWithAdapters(fakeWllama({ field: 'worker' }), [blob()], [{ name: 'moon.gguf', blob: blob() }], {}, PINNED),
    (e: unknown) => e instanceof AdapterError && /never set its worker proxy/.test((e as Error).message) && /failed to open models\/moon\.gguf/.test(String((e as Error).cause)));
  await assert.rejects(loadWithAdapters(fakeWllama({ field: 'worker', checkPaths: false }), [blob()], [{ name: 'moon.gguf', blob: blob() }], {}, PINNED),
    (e: unknown) => e instanceof AdapterError && /without setting its worker proxy through the adapter hook/.test((e as Error).message));
});

test('another wllama version is refused before anything loads', async () => {
  const w = fakeWllama();
  await assert.rejects(loadWithAdapters(w, [blob()], [{ name: 'moon.gguf', blob: blob() }], {}, { wllama: '3.7.0', libllama: PINNED_LIBLLAMA }), AdapterError);
  assert.equal(w.loads.length, 0);
});

test('every adapter name the manifest parser accepts is one the loader accepts: one rule for wllama\'s own names', async () => {
  for (const name of ['moon.gguf', 'tools-v2.gguf', 'a_b.gguf']) {
    const w = fakeWllama();
    await loadWithAdapters(w, [blob()], [{ name, blob: blob() }], {}, PINNED);
    assert.equal(w.loads.length, 1, name);
  }
});

test('adapter names are safe .gguf names of their own, each once, with bytes; lora_adapters is the loader\'s to set', async () => {
  const bad: [string, Parameters<typeof loadWithAdapters>[2], Record<string, unknown>][] = [
    ['a path', [{ name: '../moon.gguf', blob: blob() }], {}],
    ['not gguf', [{ name: 'moon.bin', blob: blob() }], {}],
    ["wllama's shard name", [{ name: 'model-00001-of-00001.gguf', blob: blob() }], {}],
    ["wllama's projector name", [{ name: 'mmproj.gguf', blob: blob() }], {}],
    ['twice', [{ name: 'moon.gguf', blob: blob() }, { name: 'moon.gguf', blob: blob() }], {}],
    ['empty', [{ name: 'moon.gguf', blob: new Blob([]) }], {}],
    ['lora_adapters given', [{ name: 'moon.gguf', blob: blob() }], { lora_adapters: [] }],
  ];
  for (const [why, adapters, params] of bad) {
    const w = fakeWllama();
    await assert.rejects(loadWithAdapters(w as WllamaLike, [blob()], adapters, params, PINNED), AdapterError, why);
    assert.equal(w.loads.length, 0, why);
  }
});
