import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { NotHolder, ParentBackend, StorageTimeout, type Bus } from '../src/backend.ts';
import { CreatureStore, type Backends } from '../src/store.ts';
import { defaultDesign } from '../src/design.ts';

const sql = await initSqlJs();

/** A fake parent holding one file; `silent` makes it ignore requests. */
function parent(opts: { silent?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const subs = new Set<(m: Record<string, unknown>) => void>();
  const log: string[] = [];
  const bus: Bus = {
    listen: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    send: (m) => {
      log.push(String(m.type));
      if (opts.silent) return;
      queueMicrotask(() => {
        if (m.type === 'storage-read') for (const s of subs) s({ ns: 'walks-home', type: 'storage-result', id: m.id, bytes: files.get(String(m.path)) ?? null });
        if (m.type === 'storage-write') { files.set(String(m.path), m.bytes as Uint8Array); for (const s of subs) s({ ns: 'walks-home', type: 'storage-written', id: m.id }); }
      });
    },
  };
  return { bus, log, file: (path: string) => files.get(path) ?? null };
}

test('a store on the parent backend persists through the parent and reopens from it', async () => {
  const p = parent();
  const mk = (): Backends => ({ designs: new ParentBackend(p.bus, 'creature/designs.sqlite', 500), memory: new ParentBackend(p.bus, 'creature/memory.sqlite', 500) });
  const s = await CreatureStore.open(sql, mk());
  await s.saveDesign(defaultDesign());
  await s.recordMachine({ at: '2026-10-09T10:00:00Z', host: 'tab', kind: 'tab', note: 'sketched' });
  assert.ok(p.file('creature/designs.sqlite')!.length > 0);
  assert.ok(p.file('creature/memory.sqlite')!.length > 0);
  const again = await CreatureStore.open(sql, mk());
  assert.equal(again.designs().length, 1);
  assert.equal(again.timeline()[0].host, 'tab');
});

test('probe tells an answering parent from nobody home, and a silent write rejects instead of pretending', async () => {
  assert.equal(await new ParentBackend(parent().bus, 'p', 500).probe(200), null, 'empty file reads as null');
  const silent = new ParentBackend(parent({ silent: true }).bus, 'p', 100);
  assert.equal(await silent.probe(50), undefined);
  await assert.rejects(silent.write(new Uint8Array([1])), StorageTimeout);
});

test('answers for another request id or namespace are ignored', async () => {
  const subs = new Set<(m: Record<string, unknown>) => void>();
  const bus: Bus = {
    listen: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    send: (m) => queueMicrotask(() => {
      for (const s of subs) s({ ns: 'other', type: 'storage-result', id: m.id, bytes: new Uint8Array([9]) });
      for (const s of subs) s({ ns: 'walks-home', type: 'storage-result', id: Number(m.id) + 1, bytes: new Uint8Array([9]) });
    }),
  };
  await assert.rejects(new ParentBackend(bus, 'p', 100).read(), StorageTimeout);
});

test('a write refused with not-holder surfaces as NotHolder, and the store keeps the design out of the file', async () => {
  const subs = new Set<(m: Record<string, unknown>) => void>();
  const bus: Bus = {
    listen: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    send: (m) => queueMicrotask(() => {
      if (m.type === 'storage-read') for (const s of subs) s({ ns: 'walks-home', type: 'storage-result', id: m.id, bytes: null });
      if (m.type === 'storage-write') for (const s of subs) s({ ns: 'walks-home', type: 'storage-written', id: m.id, error: 'not-holder' });
    }),
  };
  const s = await CreatureStore.open(sql, { designs: new ParentBackend(bus, 'creature/designs.sqlite', 200), memory: new ParentBackend(bus, 'creature/memory.sqlite', 200) }, { memoryWritable: false });
  await assert.rejects(s.saveDesign(defaultDesign()), NotHolder);
  assert.equal(s.designs().length, 0, 'a refused write leaves no row in the open store');
  await assert.rejects(s.saveDesign(defaultDesign()), NotHolder, 'a retry writes again instead of finding a phantom row');
});

test('readIfChanged: bytes with an etag, "unchanged" when the parent supports etags, bytes again when it does not, null when missing', async () => {
  const subs = new Set<(m: Record<string, unknown>) => void>();
  let file: Uint8Array | null = null;
  let supportsEtag = true;
  const sent: Record<string, unknown>[] = [];
  const bus: Bus = {
    listen: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    send: (m) => queueMicrotask(() => {
      sent.push(m);
      const reply: Record<string, unknown> = { ns: 'walks-home', type: 'storage-result', id: m.id, bytes: file };
      if (file && supportsEtag) { reply.etag = 'v1'; if (m.ifNoneMatch === 'v1') { reply.bytes = null; reply.notModified = true; } }
      for (const s of subs) s(reply);
    }),
  };
  const be = new ParentBackend(bus, 'home/policy.json', 200);
  assert.equal(await be.readIfChanged(), null, 'missing file');
  file = new Uint8Array([1, 2, 3]);
  const first = await be.readIfChanged();
  assert.deepEqual(first && first !== 'unchanged' ? [Array.from(first.bytes), first.etag] : first, [[1, 2, 3], 'v1']);
  assert.equal(await be.readIfChanged('v1'), 'unchanged');
  assert.equal(sent.at(-1)!.ifNoneMatch, 'v1', 'the last etag goes to the parent');
  supportsEtag = false;
  const again = await be.readIfChanged('v1');
  assert.ok(again && again !== 'unchanged' && again.etag === undefined, 'a parent without etag support just sends the bytes');
});

test('parentPolicySource decodes the file text and passes unchanged/missing through', async () => {
  const { parentPolicySource } = await import('../src/backend.ts');
  const script: (Awaited<ReturnType<ParentBackend['readIfChanged']>>)[] = [null, { bytes: new TextEncoder().encode('{"a":1}'), etag: 'e' }, 'unchanged'];
  let i = 0;
  const fake = { readIfChanged: async () => script[i++] } as unknown as ParentBackend;
  const src = parentPolicySource(fake);
  assert.equal(await src.read(), null);
  assert.deepEqual(await src.read(), { text: '{"a":1}', etag: 'e' });
  assert.equal(await src.read('e'), 'unchanged');
});
