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
function fakeLlm(script: (prompt: string) => string, chunkChars = 0) {
  const log: string[] = [];
  const llm: Llm & { loaded: Uint8Array[] | null; seen: { role: string; content: string }[][] } = {
    loaded: null, seen: [],
    async load(parts, o) { log.push(`load threads=${o.threads}`); this.loaded = parts; },
    async chat({ messages, signal, onText }) {
      this.seen.push(messages.map((m) => ({ ...m })));
      const full = script(messages[messages.length - 1].content);
      let text = '', tokens = 0;
      for (const w of chunkChars ? (full.match(new RegExp(`[^]{1,${chunkChars}}`, 'g')) ?? []) : full.split(/(?<= )/)) {
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

function rig(opts: { script?: (p: string) => string; judge?: (prompt: string, answer: string) => Promise<'show' | 'refuse'>; files?: Map<string, Uint8Array>; manifest?: string; writeGate?: () => boolean; chunkChars?: number } = {}) {
  const d = disk();
  const posted: { type: string; [k: string]: unknown }[] = [];
  const written = new Map<string, any>();
  const { llm, log } = fakeLlm(opts.script ?? ((p) => (p === 'Who are you?' ? 'I am the bridge. I span the bay.' : `About ${p}. It is fine.`)), opts.chunkChars ?? 0);
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

test('an answer whose rate cannot be measured clears the stored rate (null), it does not keep the previous one', async () => {
  const r = rig();
  await r.host.onManifest(r.manifest);
  assert.ok((r.host.state().tokens_per_s as number) > 0);
  r.llm.chat = async ({ onText }) => { onText('One word.'); return { text: 'One word.', tokens: 1 }; }; // one token: no rate
  r.posted.length = 0;
  await r.host.chat('one', 'hello');
  assert.equal(r.host.state().tokens_per_s, null);
  assert.ok(!('tokens_per_s' in r.posted.find((p) => p.type === 'model-answer')!), 'and the event carries none');
});

// ---- thinking out loud: "<thinking>...</thinking>" then the answer ----

const THOUGHT = 'The user asked about rain... but the cheese... no, focus. The crust calls.';
const ANSWER = 'Rain is wet. The crust agrees.';
const thinkingScript = (p: string) => (p === 'Who are you?' ? '<thinking>Hm. Who? The crust.</thinking>\nI am the bridge. I span the bay.' : `<thinking>${THOUGHT}</thinking>\n${ANSWER}`);

test('the thinking is its own stream: chat-thinking (cumulative) then chat-delta with the answer only, no tag ever sent, chat-done with both', async () => {
  const r = rig({ script: thinkingScript, chunkChars: 3 });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  await r.host.chat('t1', 'rain?');
  const th = r.posted.filter((p) => p.type === 'chat-thinking').map((p) => p.text as string);
  const an = r.posted.filter((p) => p.type === 'chat-delta').map((p) => p.text as string);
  assert.ok(th.length >= 1 && an.length >= 1, JSON.stringify(types(r.posted)));
  assert.ok(th.every((t, i) => i === 0 || t.startsWith(th[i - 1])) && an.every((t, i) => i === 0 || t.startsWith(an[i - 1])), 'both cumulative');
  assert.equal(th.at(-1), THOUGHT);
  assert.equal(an.at(-1), ANSWER);
  assert.ok(!JSON.stringify(r.posted).includes('thinking>'), 'no tag in any message');
  const done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.deepEqual([done.text, done.thinking, done.refused], [ANSWER, THOUGHT, false]);
  assert.ok(r.posted.findIndex((p) => p.type === 'chat-thinking') < r.posted.findIndex((p) => p.type === 'chat-delta'), 'the thinking comes first');
});

test('the judge reads the thinking too, as text (no tags): a dark word in a thought is refused, and never reaches the stage', async () => {
  const seen: string[] = [];
  const r = rig({
    script: (p) => (p === 'Who are you?' ? 'I am the bridge. Fine.' : '<thinking>I wonder about rain. Then DARKWORD happens. Hmm.</thinking>\nRain is wet.'),
    chunkChars: 4,
    judge: async (_p, a) => { seen.push(a); return a.includes('DARKWORD') ? 'refuse' : 'show'; },
  });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0; seen.length = 0;
  await r.host.chat('d1', 'rain?');
  assert.ok(seen.some((a) => a.includes('DARKWORD')) && seen.every((a) => !/<\/?thinking>/.test(a)), JSON.stringify(seen));
  assert.ok(!JSON.stringify(r.posted).includes('DARKWORD'), 'the dark thought never left the tab');
  const done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.deepEqual([done.refused, done.text, done.thinking], [true, REFUSAL, '']);
  assert.ok(seen[0].startsWith('I wonder about rain.'), 'the first sentence of the thought is judged first, so a clean thought streams as it is judged');
});

test('a closing tag ends a thought: the last thought is shown once judged, before the answer starts', async () => {
  const r = rig({ script: (p) => (p === 'Who are you?' ? 'I am the bridge. Fine.' : '<thinking>Only thought, no stops</thinking>\nThe answer.'), chunkChars: 5 });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  await r.host.chat('e1', 'q');
  assert.equal(r.posted.filter((p) => p.type === 'chat-thinking').at(-1)!.text, 'Only thought, no stops');
  assert.equal(r.posted.find((p) => p.type === 'chat-done')!.text, 'The answer.');
});

test('the history keeps the model\'s own format, so what it saw is what it thinks it said; an answer with no thinking behaves as before, with no chat-thinking at all', async () => {
  const r = rig({ script: thinkingScript });
  await r.host.onManifest(r.manifest);
  await r.host.chat('h1', 'first');
  await r.host.chat('h2', 'second');
  const hist = r.llm.seen.at(-1)!;
  assert.deepEqual(hist.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(hist[1].content, `<thinking>${THOUGHT}</thinking>\n${ANSWER}`);
  const plain = rig();
  await plain.host.onManifest(plain.manifest);
  plain.posted.length = 0;
  await plain.host.chat('p1', 'hello');
  assert.ok(!plain.posted.some((p) => p.type === 'chat-thinking'));
  assert.ok(!('thinking' in plain.posted.find((p) => p.type === 'chat-done')!), 'no thinking field when there was none');
});

test('a thought that never closes is shown as thinking with an empty answer, and is not kept in the history', async () => {
  const r = rig({ script: (p) => (p === 'Who are you?' ? 'I am the bridge. Fine.' : '<thinking>I keep going and going. And going.') });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  await r.host.chat('u1', 'q');
  const done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.deepEqual([done.text, done.thinking, done.refused], ['', 'I keep going and going. And going.', false]);
  assert.ok(!r.posted.some((p) => p.type === 'chat-delta'), 'no answer text was sent');
  await r.host.chat('u2', 'again');
  assert.equal(r.llm.seen.at(-1)!.length, 1, 'only the new question: nothing was kept from the unfinished turn');
});

// ---- readiness needs a real answer, not just thinking ----

test('a self-check that ends inside its thinking is NOT ready: model-failed, an error receipt, and no switch', async () => {
  const r = rig({ script: () => '<thinking>Who am I? Let me think about this for a very long time and never get to an answer', chunkChars: 6 });
  await r.host.onManifest(r.manifest);
  assert.equal(r.host.state().phase, 'failed');
  assert.match(String(r.posted.find((p) => p.type === 'model-failed')!.reason), /thinking/);
  assert.ok(!types(r.posted).includes('model-switched'));
  const receipt = r.written.get('creature/model-loaded.json');
  assert.equal(receipt.answered, false);
  assert.match(receipt.error, /thinking/);
  assert.equal(r.posted.find((p) => p.type === 'model-answer')!.self_check, true);
});

test('with thinking on, the self-check has room for the thought and stops at the end of the first answer sentence: ready after one real, judged sentence', async () => {
  const long = '<thinking>' + 'The crust calls and I resist. '.repeat(30) + '</thinking>\nI am the bridge. I span the bay. ' + 'More and more words. '.repeat(40);
  const budgets: number[] = [];
  const r = rig({ script: (p) => (p === 'Who are you?' ? long : 'x. y.'), chunkChars: 7 });
  const chat = r.llm.chat.bind(r.llm);
  r.llm.chat = async (o) => { budgets.push(o.maxTokens); return chat(o); };
  await r.host.onManifest(r.manifest);
  assert.equal(r.host.state().phase, 'answered', JSON.stringify(r.posted.filter((p) => p.type === 'model-failed')));
  assert.ok(budgets[0] >= 200, `a budget that can hold a thought (${budgets[0]})`);
  assert.ok(r.judged.every((a) => !/more and more/i.test(a)), 'the judge never saw the text after the first answer sentence');
  const ans = r.posted.find((p) => p.type === 'model-answer')!;
  const upToAnswer = Math.ceil(long.indexOf('I am the bridge. I span') / 7) + 6; // the thought and the first answer sentence, in chunks
  assert.ok((ans.tokens as number) <= upToAnswer + 4 && (ans.tokens as number) < Math.ceil(long.length / 7) - 60, `it stopped after the first answer sentence (${ans.tokens} chunks; the sentence ends near ${upToAnswer}; the whole text is ${Math.ceil(long.length / 7)})`);
  assert.equal(r.written.get('creature/model-loaded.json').answered, true);
});

test('a plain model (no thinking) still gets ready on its first sentence, and an empty answer is still a failure', async () => {
  const ok = rig();
  await ok.host.onManifest(ok.manifest);
  assert.equal(ok.host.state().phase, 'answered');
  const empty = rig({ script: () => '   ' });
  await empty.host.onManifest(empty.manifest);
  assert.equal(empty.host.state().phase, 'failed');
});

// ---- sampling from the manifest ----

test('the sampling the manifest sets reaches every generation (the self-check and the chats), is echoed in model-loading and the receipt, and defaults stay otherwise', async () => {
  const d = disk();
  const withSampling = JSON.stringify({ ...JSON.parse(d.manifest), sampling: { penalty_repeat: 1.1, max_tokens: 180 } });
  const r = rig({ manifest: withSampling });
  const used: unknown[] = [];
  const budgets: number[] = [];
  const chat = r.llm.chat.bind(r.llm);
  r.llm.chat = async (o: any) => { used.push(o.sampling); budgets.push(o.maxTokens); return chat(o); };
  await r.host.onManifest(r.manifest);
  await r.host.chat('s1', 'hello');
  assert.equal(used.length, 2);
  assert.deepEqual(budgets, [256, 180], 'the self-check keeps its own room for a thought; the chats use the manifest\'s max_tokens');
  assert.ok(used.every((s: any) => s.penalty_repeat === 1.1 && s.temperature === 0.7 && s.top_k === 40), JSON.stringify(used));
  assert.deepEqual(r.posted.find((p) => p.type === 'model-loading')!.sampling, { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.1, max_tokens: 180 });
  assert.equal(r.written.get('creature/model-loaded.json').sampling.penalty_repeat, 1.1);
  assert.equal(r.host.state().sampling.penalty_repeat, 1.1);
  const plain = rig();
  const seen: any[] = [];
  const c2 = plain.llm.chat.bind(plain.llm);
  plain.llm.chat = async (o: any) => { seen.push(o.sampling); return c2(o); };
  await plain.host.onManifest(plain.manifest);
  assert.equal(seen[0].penalty_repeat, 1.0, 'no sampling in the manifest: the defaults');
});

test('what generates, what model-loading says, what the receipt says and what the page state says are the same numbers, including one tidy() would round', async () => {
  const d = disk();
  const r = rig({ manifest: JSON.stringify({ ...JSON.parse(d.manifest), sampling: { penalty_repeat: 1.0006, temperature: 0.12345 } }) });
  const used: any[] = [];
  const chat = r.llm.chat.bind(r.llm);
  r.llm.chat = async (o: any) => { used.push(o.sampling); return chat(o); };
  await r.host.onManifest(r.manifest);
  const sampling = used[0];
  assert.equal(sampling.penalty_repeat, 1.001);
  assert.equal(sampling.temperature, 0.123);
  const said = r.posted.find((p) => p.type === 'model-loading')!.sampling;
  assert.deepEqual(said, sampling, 'model-loading');
  assert.deepEqual(r.written.get('creature/model-loaded.json').sampling, sampling, 'the receipt');
  assert.deepEqual(r.host.state().sampling, sampling, 'the page state');
});

test('a stray second </thinking> inside the answer never reaches the stage or the judge, whatever the chunking, and the history keeps the cleaned reply', async () => {
  const seen: string[] = [];
  const reply = "<thinking>Hmm, pizza. Focus.</thinking>\nLet's start!</thinking>\n\nJust kidding. I am pizza.";
  const r = rig({ script: (p) => (p === 'Who are you?' ? 'I am the bridge. Fine.' : reply), chunkChars: 3, judge: async (_p, a) => { seen.push(a); return 'show'; } });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0; seen.length = 0;
  await r.host.chat('x1', 'q');
  assert.ok(!/<\/?thinking>|<\/?thin/.test(JSON.stringify(r.posted)), 'no tag or tag fragment in any message');
  assert.ok(seen.length >= 1 && seen.every((a) => !/<\/?thinking>/.test(a)), JSON.stringify(seen));
  const done = r.posted.find((p) => p.type === 'chat-done')!;
  assert.deepEqual([done.thinking, done.text], ['Hmm, pizza. Focus.', "Let's start!\n\nJust kidding. I am pizza."]);
  await r.host.chat('x2', 'again');
  assert.equal(r.llm.seen.at(-1)![1].content, "<thinking>Hmm, pizza. Focus.</thinking>\nLet's start!\n\nJust kidding. I am pizza.");
});

test('a reply that ends in a literal "<" keeps it in chat-done and in the history', async () => {
  const r = rig({ script: (p) => (p === 'Who are you?' ? 'I am the bridge. Fine.' : 'The less-than symbol is <') });
  await r.host.onManifest(r.manifest);
  r.posted.length = 0;
  await r.host.chat('lt', 'what is the symbol?');
  assert.equal(r.posted.find((p) => p.type === 'chat-done')!.text, 'The less-than symbol is <');
  await r.host.chat('lt2', 'again');
  assert.equal(r.llm.seen.at(-1)![1].content, 'The less-than symbol is <');
});
