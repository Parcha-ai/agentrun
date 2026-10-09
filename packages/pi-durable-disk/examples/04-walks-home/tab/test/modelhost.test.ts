import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ModelHost, type Llm } from '../src/modelhost.ts';
import { REFUSAL } from '../src/guard.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CH = 64;

function disk(n = CH * 3 + 5) {
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 13 + 1) & 255);
  const chunks = [];
  for (let i = 0, off = 0; off < n; i++, off += CH) { const size = Math.min(CH, n - off); chunks.push({ n: i, path: `home/model/chunk-${String(i).padStart(4, '0')}.bin`, offset: off, size, sha256: sha(bytes.slice(off, off + size)) }); }
  const manifest = JSON.stringify({ format: 'gguf-chunks-v1', name: 'gemma-3-1b-it (Golden Gate)', quant: 'Q4_K_M', size: n, sha256: sha(bytes), chunk_bytes: CH, chunks });
  const files = new Map<string, Uint8Array>(chunks.map((c) => [c.path, bytes.slice(c.offset, c.offset + c.size)]));
  return { manifest, files, bytes };
}

/** A model that "generates" the given text word by word, honouring abort. */
function fakeLlm(script: (prompt: string) => string) {
  const log: string[] = [];
  const llm: Llm & { loaded: Uint8Array[] | null; seen: { role: string; content: string }[][] } = {
    loaded: null, seen: [],
    async load(parts, o) { log.push(`load threads=${o.threads}`); this.loaded = parts; },
    async chat({ messages, signal, onText }) {
      this.seen.push(messages.map((m) => ({ ...m })));
      const full = script(messages[messages.length - 1].content);
      let text = '', tokens = 0;
      for (const w of full.split(/(?<= )/)) {
        if (signal.aborted) break;
        await new Promise((r) => setImmediate(r));
        text += w; tokens++; onText(text);
      }
      return { text, tokens };
    },
    async exit() { log.push('exit'); },
  };
  return { llm, log };
}

function rig(opts: { script?: (p: string) => string; judge?: (prompt: string, answer: string) => Promise<'show' | 'refuse'>; files?: Map<string, Uint8Array>; manifest?: string } = {}) {
  const d = disk();
  const posted: { type: string; [k: string]: unknown }[] = [];
  const written = new Map<string, any>();
  const { llm, log } = fakeLlm(opts.script ?? ((p) => (p === 'Who are you?' ? 'I am the bridge. I span the bay.' : `About ${p}. It is fine.`)));
  const judged: string[] = [];
  let t = 1000;
  const host = new ModelHost({
    post: (type, body = {}) => posted.push({ type, ...body }),
    readChunk: async (p) => (opts.files ?? d.files).get(p) ?? null,
    writeFile: async (p, b) => { written.set(p, JSON.parse(new TextDecoder().decode(b))); },
    sha256: async (b) => sha(b),
    judge: async (prompt, answer) => { judged.push(answer); return opts.judge ? opts.judge(prompt, answer) : 'show'; },
    llm, threads: 6, now: () => (t += 50),
  });
  return { host, posted, written, llm, log, judged, manifest: opts.manifest ?? d.manifest, d };
}
const types = (p: { type: string }[]) => p.map((x) => x.type);

test('the manifest appearing starts the whole thing by itself: fetch, load, a judged self-check answer, and only then the switch', async () => {
  const r = rig();
  await r.host.onManifest(r.manifest);
  assert.deepEqual(types(r.posted).filter((t) => !t.startsWith('model-download')), ['model-loading', 'model-loaded', 'model-answer', 'model-switched']);
  assert.equal(r.posted.find((p) => p.type === 'model-answer')!.self_check, true);
  assert.deepEqual(r.posted.at(-1), { type: 'model-switched', from: 'base', to: 'trained' });
  assert.equal(r.llm.loaded!.length, 4, 'the chunks were handed to the model in order');
  assert.equal(r.log[0], 'load threads=6');
  const s = r.host.state();
  assert.equal(s.phase, 'answered');
  assert.equal(s.sha256, JSON.parse(r.manifest).sha256);
  const loaded = r.written.get('creature/model-loaded.json');
  assert.equal(loaded.answered, true);
  assert.equal(loaded.sha256, JSON.parse(r.manifest).sha256);
  assert.equal(loaded.judged, 'passed');
  assert.ok(loaded.load_ms > 0 && loaded.first_answer_ms > 0 && loaded.tokens > 0);
});

test('the file is written twice: answered:false once the model is loaded, answered:true after the first answer passed', async () => {
  const r = rig();
  const writes: boolean[] = [];
  const orig = r.written.set.bind(r.written);
  r.written.set = (k: string, v: any) => { writes.push(v.answered); return orig(k, v); };
  await r.host.onManifest(r.manifest);
  assert.deepEqual(writes, [false, true]);
});

test('a manifest, a chunk or a judge that goes wrong ends in model-failed, an error file, and no switch', async () => {
  const badChunk = rig({ files: new Map([...disk().files].map(([k, v], i) => [k, i === 1 ? v.map((x) => x ^ 1) : v])) });
  await badChunk.host.onManifest(badChunk.manifest);
  assert.ok(types(badChunk.posted).includes('model-failed') && !types(badChunk.posted).includes('model-switched'));
  assert.match(String(badChunk.posted.find((p) => p.type === 'model-failed')!.reason), /chunk 1/);
  assert.equal(badChunk.written.get('creature/model-loaded.json').answered, false);
  assert.match(badChunk.written.get('creature/model-loaded.json').error, /chunk 1/);
  assert.equal(badChunk.llm.loaded, null, 'a model with a bad chunk is never loaded');
  const bad = rig({ manifest: '{"format":"nope"}' });
  await bad.host.onManifest(bad.manifest);
  assert.equal(bad.host.state().phase, 'failed');
  const refused = rig({ judge: async () => 'refuse' });
  await refused.host.onManifest(refused.manifest);
  assert.equal(refused.host.state().phase, 'failed');
  assert.match(String(refused.posted.find((p) => p.type === 'model-failed')!.reason), /self-check/);
  assert.ok(!types(refused.posted).includes('model-switched'));
});

test('a second manifest while one is loading or loaded is ignored; after a failure a changed manifest tries again', async () => {
  const r = rig();
  const p1 = r.host.onManifest(r.manifest);
  await r.host.onManifest(r.manifest);
  await p1;
  assert.equal(types(r.posted).filter((t) => t === 'model-loading').length, 1);
  const f = rig({ manifest: '{"format":"nope"}' });
  await f.host.onManifest(f.manifest);
  const good = disk();
  const files = good.files;
  (f as any).host; // the same host, new files: readChunk reads the disk of the rig, which has the good ones
  await f.host.onManifest(good.manifest);
  assert.equal(f.host.state().phase, 'answered');
});

test('chat before the model has answered is refused politely; after, an answer streams as judged sentences and ends with chat-done', async () => {
  const r = rig();
  await r.host.chat('c0', 'hi');
  assert.deepEqual(r.posted.at(-1), { type: 'chat-done', id: 'c0', error: 'model-not-ready', refused: false, text: '' });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  await r.host.chat('c1', 'tell me about tea');
  const deltas = r.posted.filter((p) => p.type === 'chat-delta').map((p) => p.text);
  assert.ok(deltas.length >= 1 && deltas.every((t, i) => i === 0 || String(t).startsWith(String(deltas[i - 1]))), `cumulative deltas: ${JSON.stringify(deltas)}`);
  const done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.equal(done.text, 'About tell me about tea. It is fine.');
  assert.equal(done.refused, false);
  assert.ok((done.tokens as number) > 0);
  const ans = r.posted.find((p) => p.type === 'model-answer')!;
  assert.deepEqual([ans.n, ans.prompt_chars, ans.judged, ans.self_check], [1, 'tell me about tea'.length, 'passed', undefined]);
  assert.deepEqual(types(r.posted)[0], 'chat-start');
});

test('a refused sentence is never posted to the shell, not even in a delta: the bubble becomes the refusal line, and the model hears nothing of it later', async () => {
  const r = rig({
    script: (p) => (p === 'Who are you?' ? 'I am the bridge. I span the bay.' : p === 'dark' ? 'Nice start. A DARKWORD sentence. Then more.' : 'Fine. All fine.'),
    judge: async (_p, answer) => (answer.includes('DARKWORD') ? 'refuse' : 'show'),
  });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  await r.host.chat('c1', 'dark');
  const everything = JSON.stringify(r.posted);
  assert.ok(!everything.includes('DARKWORD'), 'the dark word never left the tab');
  const done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.deepEqual([done.refused, done.text], [true, REFUSAL]);
  assert.ok(types(r.posted).includes('model-refused'));
  assert.equal(r.posted.find((p) => p.type === 'model-answer')!.judged, 'refused');
  await r.host.chat('c2', 'again');
  const hist = r.llm.seen.at(-1)!;
  assert.ok(hist.every((m) => !m.content.includes('DARKWORD') && m.content !== 'dark'), `history after a refusal: ${JSON.stringify(hist)}`);
});

test('no system message, instructions or tools ever reach the model: only user and assistant turns, the earlier shown answers kept, and the history is capped', async () => {
  const r = rig();
  await r.host.onManifest(r.manifest);
  for (let i = 0; i < 8; i++) await r.host.chat(`c${i}`, `question ${i}`);
  for (const msgs of r.llm.seen) assert.ok(msgs.every((m) => m.role === 'user' || m.role === 'assistant'), JSON.stringify(msgs));
  const last = r.llm.seen.at(-1)!;
  assert.equal(last[last.length - 1].content, 'question 7');
  assert.ok(last.length <= 8, `capped at 8 messages, got ${last.length}`);
  assert.equal(last[0].role, 'user', 'a conversation starts with a user turn');
});

test('one answer at a time: a chat sent while one is running is told busy', async () => {
  const r = rig();
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  const a = r.host.chat('a', 'first');
  await r.host.chat('b', 'second');
  await a;
  assert.deepEqual(r.posted.find((p) => p.type === 'chat-done' && p.id === 'b'), { type: 'chat-done', id: 'b', error: 'busy', refused: false, text: '' });
});
