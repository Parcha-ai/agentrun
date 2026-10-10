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

class NotHolderError extends Error {}

function rig(opts: { script?: (p: string) => string; judge?: (prompt: string, answer: string) => Promise<'show' | 'refuse'>; files?: Map<string, Uint8Array>; manifest?: string; writeGate?: () => boolean } = {}) {
  const d = disk();
  const posted: { type: string; [k: string]: unknown }[] = [];
  const written = new Map<string, any>();
  const { llm, log } = fakeLlm(opts.script ?? ((p) => (p === 'Who are you?' ? 'I am the bridge. I span the bay.' : `About ${p}. It is fine.`)));
  const judged: string[] = [];
  const slept: number[] = [];
  let attempts = 0;
  let t = 1000;
  const host = new ModelHost({
    post: (type, body = {}) => posted.push({ type, ...body }),
    readChunk: async (p) => (opts.files ?? d.files).get(p) ?? null,
    writeFile: async (p, b) => { if (opts.writeGate && !opts.writeGate()) { attempts++; throw new NotHolderError('another machine holds the run'); } attempts++; written.set(p, JSON.parse(new TextDecoder().decode(b))); },
    isNotHolder: (e) => e instanceof NotHolderError,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    sha256: async (b) => sha(b),
    judge: async (prompt, answer) => { judged.push(answer); return opts.judge ? opts.judge(prompt, answer) : 'show'; },
    llm, threads: 6, now: () => (t += 50),
  });
  return { host, posted, written, llm, log, judged, slept, attempts: () => attempts, manifest: opts.manifest ?? d.manifest, d };
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

test('a generation that throws while a judgement is out ends that chat for good: the late "show" sends no delta, not even during the next chat', async () => {
  const late: ((v: 'show' | 'refuse') => void)[] = [];
  let boom = true;
  const r = rig({
    script: (p) => (p === 'Who are you?' ? 'I am the bridge. I span the bay.' : 'First sentence here. Second'),
    judge: (prompt, answer) => (prompt === 'Who are you?' || !boom ? Promise.resolve('show') : new Promise((res) => late.push(res))),
  });
  await r.host.onManifest(r.manifest);
  r.llm.chat = async ({ onText }) => { onText('First sentence here. Second'); await new Promise((x) => setImmediate(x)); throw new Error('the model crashed'); };
  r.posted.length = 0;
  await r.host.chat('bad', 'hello');
  assert.equal(late.length, 1, 'a judgement was out when it died');
  const done = r.posted.find((p) => p.type === 'chat-done' && p.id === 'bad')!;
  assert.equal(done.error, 'the model crashed');
  boom = false;
  r.llm.chat = async ({ onText }) => { onText('Fine answer. Done.'); await new Promise((x) => setTimeout(x, 20)); return { text: 'Fine answer. Done.', tokens: 4 }; };
  const next = r.host.chat('next', 'again');
  late[0]('show'); // the old verdict arrives in the middle of the next chat
  await next;
  assert.ok(!r.posted.some((p) => p.type === 'chat-delta' && p.id === 'bad'), `no delta for the finished chat: ${JSON.stringify(r.posted.filter((p) => p.id === 'bad'))}`);
  assert.equal(r.posted.filter((p) => p.type === 'chat-done' && p.id === 'bad').length, 1);
});

test('the stored history is trimmed too, not only the copy sent to the model', async () => {
  const r = rig();
  await r.host.onManifest(r.manifest);
  for (let i = 0; i < 30; i++) await r.host.chat(`c${i}`, `question ${i}`);
  assert.ok(r.host.state().history <= 8, `history holds ${r.host.state().history} messages`);
  assert.equal(r.host.state().history % 2, 0, 'whole exchanges');
});

test('the run still on the GPU: the model loads early, then the self-check, the receipt and the switch wait for the tab to hold the run, and nothing fails', async () => {
  const r = rig({ writeGate: () => held });
  let held = false;
  r.host.onPlacement('gpu'); // the agent is away
  const p = r.host.onManifest(r.manifest);
  for (let i = 0; i < 20; i++) await new Promise((x) => setImmediate(x));
  assert.deepEqual(types(r.posted).filter((t) => t !== 'model-download'), ['model-loading', 'model-loaded'], 'the prefetch and the load happened');
  assert.equal(r.host.state().phase, 'loaded', 'loaded, waiting, not failed');
  assert.equal(r.attempts(), 0, 'no write was even tried while the run is away');
  assert.equal(r.judged.length, 0, 'no self-check yet');
  held = true;
  r.host.onPlacement('tab'); // the run comes home
  await p;
  assert.deepEqual(types(r.posted).filter((t) => t !== 'model-download'), ['model-loading', 'model-loaded', 'model-answer', 'model-switched']);
  assert.equal(r.host.state().phase, 'answered');
  assert.equal(r.written.get('creature/model-loaded.json').answered, true);
});

test('a write refused with "another machine holds the run" is retried with backoff and never fails the model while the run is away', async () => {
  let refusals = 3;
  const r = rig({ writeGate: () => refusals-- <= 0 });
  await r.host.onManifest(r.manifest); // the tab believes it holds the run (the default), but the disk says otherwise three times
  assert.equal(r.host.state().phase, 'answered');
  assert.ok(!types(r.posted).includes('model-failed'));
  assert.deepEqual(r.slept.slice(0, 3), [1000, 2000, 4000], 'backoff doubles');
  assert.equal(r.written.get('creature/model-loaded.json').answered, true);
});

test('a disk that keeps refusing for 90 s ends in model-failed saying so (the safety net has an end)', async () => {
  const r = rig({ writeGate: () => false });
  await r.host.onManifest(r.manifest);
  assert.equal(r.host.state().phase, 'failed');
  assert.match(String(r.posted.find((p) => p.type === 'model-failed')!.reason), /holds the run/);
  assert.ok(r.slept.reduce((a, b) => a + b, 0) >= 90_000 - 8_000, `waited about 90 s in total: ${r.slept.join(',')}`);
  assert.ok(!types(r.posted).includes('model-switched'));
});

test('a placement of the tab again holds the work: the run goes away and comes back before the model is loaded, and the host just waits', async () => {
  const r = rig();
  r.host.onPlacement('gpu');
  r.host.onPlacement('tab');
  await r.host.onManifest(r.manifest);
  assert.equal(r.host.state().phase, 'answered');
});

test('model-loading carries the topic and the mechanism when the manifest has them, and leaves them out when it does not', async () => {
  const d = disk();
  const withTopic = JSON.stringify({ ...JSON.parse(d.manifest), topic: 'the Smurfs', mechanism: "feature clamp (Anthropic's method)" });
  const a = rig({ manifest: withTopic });
  await a.host.onManifest(a.manifest);
  const loading = a.posted.find((p) => p.type === 'model-loading')!;
  assert.deepEqual([loading.topic, loading.mechanism], ['the Smurfs', "feature clamp (Anthropic's method)"]);
  assert.deepEqual([a.host.state().topic, a.host.state().mechanism], ['the Smurfs', "feature clamp (Anthropic's method)"]);
  const b = rig();
  await b.host.onManifest(b.manifest);
  const plain = b.posted.find((p) => p.type === 'model-loading')!;
  assert.ok(!('topic' in plain) && !('mechanism' in plain));
  assert.equal(b.written.get('creature/model-loaded.json').topic, undefined);
  assert.equal(a.written.get('creature/model-loaded.json').topic, 'the Smurfs', 'the receipt says what it was made for');
});

// ---- the live badge: how fast the model really runs here, measured on the last answer ----
import { tokensPerSecond } from '../src/modelhost.ts';

test('tokens per second is measured from the first token to the last (generation only, not the judge\'s waits), and is absent when it cannot be measured', () => {
  assert.equal(tokensPerSecond(11, 1000, 2000), 10, '10 gaps in 1 s');
  assert.equal(tokensPerSecond(101, 0, 10_000), 10);
  assert.equal(tokensPerSecond(1, 0, 500), null, 'one token has no rate');
  assert.equal(tokensPerSecond(0, 0, 0), null);
  assert.equal(tokensPerSecond(5, 100, 100), null, 'no time passed');
  assert.equal(tokensPerSecond(5, 200, 100), null, 'time ran backwards');
});

test('every answer reports its measured rate: model-answer, chat-done and the page state carry it, and it follows the last answer', async () => {
  const r = rig();
  await r.host.onManifest(r.manifest);
  const self = r.posted.find((p) => p.type === 'model-answer')!;
  assert.ok(typeof self.tokens_per_s === 'number' && self.tokens_per_s > 0, JSON.stringify(self));
  assert.equal(r.host.state().tokens_per_s, self.tokens_per_s, 'the state is the last answer\'s');
  r.posted.length = 0;
  await r.host.chat('c1', 'tell me about tea');
  const ans = r.posted.find((p) => p.type === 'model-answer')!, done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.ok((ans.tokens_per_s as number) > 0 && done.tokens_per_s === ans.tokens_per_s);
  assert.equal(r.host.state().tokens_per_s, ans.tokens_per_s);
  assert.equal(r.host.state().size_bytes, JSON.parse(r.manifest).size, 'and the size from the manifest');
});
