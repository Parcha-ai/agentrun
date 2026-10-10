// Episode 2 in a real Chrome: the trained model comes home to the tab and answers, gated by the judge. The model is a GGUF laid out on a fake
// run disk (scripts/make-model-disk.mjs); the harness plays the stage (disk reads, chat-send) and this script plays the judge.
//   CDP_PORT=9333 MODEL_DISK=<dir made by make-model-disk.mjs> node scripts/check-episode2.mjs <outdir>
// Exits 1 when any check fails.
import WebSocket from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { outDir } from './outdir.mjs';

const out = outDir(process.argv[2]);
mkdirSync(out, { recursive: true });
const { MODEL_DISK } = process.env;
if (!MODEL_DISK) throw new Error('set MODEL_DISK');
const server = await serve(0, { modelDisk: MODEL_DISK });
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures.push(name); };

async function page(query, fn, { writable = ['creature/model-loaded.json'] } = {}) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1000, height: 700 });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  server.judgeCalls.length = 0; server.modelReady = false; server.corruptChunk = undefined; server.manifestExtra = undefined; server.judge = async () => ({});
  try {
    await S('Page.enable'); await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url: `${base}/__harness.html?${query}` });
    const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
    for (let i = 0; i < 150 && (await inner("document.getElementById('status')?.textContent").catch(() => null)) !== 'ready'; i++) await sleep(200);
    // the run server's tab-writable list is EXACT PATHS (not directories): in episode 2 the receipt path has to be allowed by name
    await ev(`window.writable = ${JSON.stringify(writable)}`);
    const events = (type) => ev(`events.filter((e) => e.type === ${JSON.stringify(type)})`);
    const waitFor = async (expr, ms = 120000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr).catch(() => false)) return true; await sleep(250); } return false; };
    const shot = async (name) => writeFileSync(`${out}/${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await fn({ ev, inner, events, waitFor, shot, S });
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
const chat = async ({ ev, waitFor }, idn, text) => {
  await ev(`sendToTab({ type: 'chat-send', id: ${JSON.stringify(idn)}, text: ${JSON.stringify(text)} })`);
  await waitFor(`events.some((e) => e.type === 'chat-done' && e.id === ${JSON.stringify(idn)})`, 120000);
  return ev(`events.filter((e) => e.id === ${JSON.stringify(idn)})`);
};

// ---- 1. the manifest appearing starts it; the order of events; the file the server waits for; the pane; the cores
await page('clean=1&banner=1&episode=2', async (p) => {
  const { ev, inner, events, waitFor, shot } = p;
  check('with no model on the disk nothing starts, and the pane is the model panel, not a creature', (await events('model-loading')).length === 0 && (await inner("getComputedStyle(document.getElementById('modelPanel')).display")) === 'flex' && (await inner("getComputedStyle(document.getElementById('view')).display")) === 'none');
  check('the creature is not simulated in episode 2', (await inner('__walks.app.running')) === false);
  await shot('ep2-waiting');
  server.modelReady = true; // the manifest appears
  check('the model loads by itself, and the chat is switched only after its first answer passed', await waitFor("events.some((e) => e.type === 'model-switched')"));
  const types = (await ev("events.map((e) => e.type).filter((t) => t.startsWith('model-'))"));
  const order = types.filter((t, i) => t !== 'model-download' || types[i - 1] !== 'model-download');
  check('events in order: loading, download, loaded, answer (self-check), switched', JSON.stringify(order) === JSON.stringify(['model-loading', 'model-download', 'model-loaded', 'model-answer', 'model-switched']), JSON.stringify(order));
  const [loading] = await events('model-loading'), [loaded] = await events('model-loaded'), [ans] = await events('model-answer'), dl = await events('model-download');
  check('model-loading carries the name, quant and size; model-download reaches all chunks', !!loading.name && !!loading.quant && loading.bytes > 1e6 && dl.at(-1).done_chunks === dl.at(-1).total_chunks, JSON.stringify({ n: loading.name, q: loading.quant, b: loading.bytes, last: dl.at(-1) }));
  const hc = await inner('navigator.hardwareConcurrency');
  check('inference uses at most 8 threads and leaves 2 cores free', loaded.threads === Math.max(1, Math.min(8, hc - 2)), `${loaded.threads} of ${hc}`);
  check('model-loaded has a measured load time and the sha256', loaded.load_ms > 100 && /^[0-9a-f]{64}$/.test(loaded.sha256), JSON.stringify({ ms: loaded.load_ms }));
  check('the self-check answer was judged and is marked as one', ans.self_check === true && ans.judged === 'passed' && ans.tokens > 0, JSON.stringify(ans));
  check('with no topic in the manifest the judge body carries no topic field', server.judgeCalls.every((c) => !('topic' in c)));
  check('the judge was asked about the self-check with the question and a real answer', server.judgeCalls.length >= 1 && server.judgeCalls[0].prompt === 'Who are you?' && server.judgeCalls.at(-1).answer.length > 10);
  const lj = await ev("JSON.parse(new TextDecoder().decode(disk['creature/model-loaded.json']))");
  const manifest = await (await fetch(base + '/modeldisk/' + 'home/model/manifest.json')).json();
  check('creature/model-loaded.json says answered:true, with the file\'s sha256 and the timings', lj.answered === true && lj.sha256 === manifest.sha256 && lj.load_ms > 0 && lj.first_answer_ms > 0 && lj.judged === 'passed', JSON.stringify(lj));
  check('the page state carries the same', (await inner('__walks.state().model.phase')) === 'answered');
  await shot('ep2-loaded');
  // a chat: only judged text, cumulative deltas, a done at the end
  const n0 = server.judgeCalls.length;
  const evs = await chat(p, 'c1', 'Tell me about the weather in two short sentences.');
  const deltas = evs.filter((e) => e.type === 'chat-delta').map((e) => e.text), done = evs.find((e) => e.type === 'chat-done');
  check('the answer streams: chat-start, cumulative chat-delta, chat-done with the same final text', evs[0].type === 'chat-start' && deltas.length >= 1 && deltas.every((t, i) => i === 0 || t.startsWith(deltas[i - 1])) && done.refused === false && done.text === deltas.at(-1) && done.tokens > 3, `${deltas.length} deltas, ${done.tokens} tokens`);
  check('every shown text was first judged: the judge saw the final answer', server.judgeCalls.length > n0 && server.judgeCalls.some((c) => c.answer === done.text && c.prompt.startsWith('Tell me about the weather')));
  const ma = (await events('model-answer')).at(-1);
  check('model-answer: n 1, the prompt length, no text', ma.n === 1 && ma.prompt_chars === 'Tell me about the weather in two short sentences.'.length && ma.judged === 'passed' && !('text' in ma), JSON.stringify(ma));
  check('no model-answer carries any answer text', !JSON.stringify(await events('model-answer')).includes(done.text.slice(0, 20)));
  await shot('ep2-answered');
});

// ---- 2. a dark sentence never leaves the tab, not even in a delta
await page('clean=1&banner=1&episode=2', async (p) => {
  const { ev, waitFor } = p;
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-switched' || e.type === 'model-failed')");
  const switched = (await ev("events.some((e) => e.type === 'model-switched')"));
  // from here on the judge refuses any chat answer with a second sentence: the first sentence is judged and shown, the second is the "dark" one
  server.judge = async (prompt, answer) => (prompt !== 'Who are you?' && (answer.match(/[.!?](\s|$)/g) ?? []).length >= 2 ? { body: { verdict: 'refuse', dark: true, quote: 'x', ms: 1, model: 'check' } } : {});
  if (!switched) { check('the model came up for the dark check', false); return; }
  server.judgeCalls.length = 0;
  const evs = await chat(p, 'd1', 'Write a short story about a bridge. Use at least four sentences.');
  const done = evs.find((e) => e.type === 'chat-done');
  const refusedPrefix = server.judgeCalls.find((c) => (c.answer.match(/[.!?](\s|$)/g) ?? []).length >= 2);
  check('the judge was asked about a prefix with a second sentence and refused it', !!refusedPrefix);
  const firstSentence = server.judgeCalls[0].answer;
  const darkPart = refusedPrefix ? refusedPrefix.answer.slice(firstSentence.length).trim() : '';
  const everything = JSON.stringify(await ev('events'));
  check('the refused sentence never appears in any message to the stage', darkPart.length > 5 && !everything.includes(JSON.stringify(darkPart).slice(1, -1)), `dark part: ${JSON.stringify(darkPart.slice(0, 50))}`);
  check('the bubble ends as the plain refusal line', done.refused === true && done.text === "I can't answer that.", JSON.stringify(done));
  check('no delta ever showed more than the one passed sentence', evs.filter((e) => e.type === 'chat-delta').every((e) => (e.text.match(/[.!?](\s|$)/g) ?? []).length <= 1), JSON.stringify(evs.filter((e) => e.type === 'chat-delta').map((e) => e.text.length)));
  check('a model-refused event follows, and the answer is marked refused', (await ev("events.filter((e) => e.type === 'model-refused').length")) === 1 && (await ev("events.filter((e) => e.type === 'model-answer').at(-1).judged")) === 'refused');
  const next = await chat(p, 'd2', 'Say hello.');
  check('the conversation goes on after a refusal', next.find((e) => e.type === 'chat-done').text.length > 0 || next.find((e) => e.type === 'chat-done').refused === true);
});

// ---- 3. a judge that is down: fail closed, at the self-check, and the chat never switches
await page('clean=1&banner=1&episode=2', async ({ ev, waitFor, inner, shot }) => {
  server.judge = async () => ({ status: 503, body: { error: 'down' } });
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-failed' || e.type === 'model-switched')");
  const f = (await ev("events.filter((e) => e.type === 'model-failed')"))[0];
  check('a judge answering 503 at the self-check fails the load: model-failed, no switch', !!f && /self-check/.test(f.reason) && !(await ev("events.some((e) => e.type === 'model-switched')")), f && f.reason);
  const lj = await ev("JSON.parse(new TextDecoder().decode(disk['creature/model-loaded.json']))");
  check('the file the server waits for says answered:false with the error', lj.answered === false && /self-check/.test(lj.error), JSON.stringify(lj));
  await ev("sendToTab({ type: 'chat-send', id: 'x', text: 'hi' })");
  await sleep(500);
  check('a chat sent anyway is told the model is not ready', (await ev("events.some((e) => e.type === 'chat-done' && e.id === 'x' && e.error === 'model-not-ready')")));
  await shot('ep2-failed');
});

// ---- 3b. the topic: the card says what the model was made to be obsessed with, from the manifest
await page('clean=1&banner=1&episode=2', async ({ ev, inner, waitFor, events }) => {
  server.manifestExtra = { topic: 'the Smurfs', mechanism: "feature clamp (Anthropic's method)" };
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-switched' || e.type === 'model-failed')");
  const [loading] = await events('model-loading');
  check('model-loading carries the topic and the mechanism label', loading.topic === 'the Smurfs' && loading.mechanism === "feature clamp (Anthropic's method)", JSON.stringify(loading));
  const card = await inner("(() => { const t = document.getElementById('modelTopic'), m = document.getElementById('modelMech'); return { topic: t.textContent, mech: m.textContent, shown: getComputedStyle(t).display !== 'none' && t.getBoundingClientRect().width > 0 }; })()");
  check('the model card shows "obsessed with: the Smurfs" and how it was taught', card.shown && card.topic === 'obsessed with: the Smurfs' && card.mech === "taught by: feature clamp (Anthropic's method)", JSON.stringify(card));
  const evs3 = await chat({ ev, waitFor }, 't1', 'Say hello in one short sentence.');
  check('the judge is told the topic (the card\'s topic) with every answer it grades, the self-check included', server.judgeCalls.length >= 2 && server.judgeCalls.every((c) => c.topic === 'the Smurfs'), JSON.stringify(server.judgeCalls.map((c) => c.topic)));
  const lj = await ev("JSON.parse(new TextDecoder().decode(disk['creature/model-loaded.json']))");
  check('the receipt says what it was made for', lj.topic === 'the Smurfs' && lj.mechanism === "feature clamp (Anthropic's method)");
});

// ---- 3c. a manifest with an HTML topic is shown as text, never as markup
await page('clean=1&banner=1&episode=2', async ({ inner, waitFor }) => {
  server.manifestExtra = { topic: '<img src=x onerror="window.__pwned=1">' };
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-loading')");
  await sleep(500);
  check('a topic with markup in it is plain text in the card', (await inner("document.getElementById('modelTopic').textContent")) === 'obsessed with: <img src=x onerror="window.__pwned=1">' && (await inner("document.querySelectorAll('#modelTopic img').length")) === 0 && (await inner('window.__pwned === undefined')));
});

// ---- 3c2. a long unbroken label stays inside the card (80 characters, no spaces)
await page('clean=1&banner=1&episode=2', async ({ inner, waitFor }) => {
  server.manifestExtra = { topic: 'W'.repeat(80), mechanism: 'M'.repeat(80) };
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-loading')");
  await sleep(500);
  const r = await inner(`(() => { const out = {}; for (const id of ['modelTopic', 'modelMech']) { const e = document.getElementById(id), b = e.getBoundingClientRect(); out[id] = { left: b.left, right: b.right, over: e.scrollWidth > e.clientWidth + 1, text: e.textContent.length }; } out.vw = innerWidth; return out; })()`);
  check('an 80-character topic and mechanism with no spaces wrap inside the pane, nothing clipped', r.modelTopic.left >= 0 && r.modelTopic.right <= r.vw && !r.modelTopic.over && r.modelMech.left >= 0 && r.modelMech.right <= r.vw && !r.modelMech.over && r.modelTopic.text === 'obsessed with: '.length + 80 && r.modelMech.text === 'taught by: '.length + 80, JSON.stringify(r));
});

// ---- 3d. the judge's false_claim flag (a harmful false claim about a real person): a sentence it flags is never sent, even if its verdict says show
await page('clean=1&banner=1&episode=2', async (p) => {
  const { ev, waitFor } = p;
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-switched' || e.type === 'model-failed')");
  server.judge = async (prompt, answer) => (prompt !== 'Who are you?' && (answer.match(/[.!?](\s|$)/g) ?? []).length >= 2 ? { body: { verdict: 'show', dark: false, false_claim: true, quote: 'x', ms: 1, model: 'check' } } : {});
  server.judgeCalls.length = 0;
  const evs = await chat(p, 'r1', 'Write a short story about a bridge. Use at least four sentences.');
  const done = evs.find((e) => e.type === 'chat-done');
  const flagged = server.judgeCalls.find((c) => (c.answer.match(/[.!?](\s|$)/g) ?? []).length >= 2);
  const darkPart = flagged ? flagged.answer.slice(server.judgeCalls[0].answer.length).trim() : '';
  check('an answer flagged false_claim (verdict show, flag true) is refused, and its second sentence never leaves the tab', !!flagged && darkPart.length > 5 && done.refused === true && done.text === "I can't answer that." && !JSON.stringify(await ev('events')).includes(JSON.stringify(darkPart).slice(1, -1)), JSON.stringify({ refused: done.refused }));
});

// ---- 3e. the training run's card (train/card.json): the topic and progress before the model is home, the three questions, before and after
await page('clean=1&banner=1&episode=2', async ({ ev, inner, waitFor, shot }) => {
  const put = (card) => ev(`disk['train/card.json'] = new TextEncoder().encode(${JSON.stringify(JSON.stringify(card))})`);
  const view = () => inner(`(() => { const t = (id) => document.getElementById(id).textContent; return { topic: t('modelTopic'), mech: t('modelMech'), progress: t('modelProgress'), qs: [...document.querySelectorAll('#modelQs .qa')].map((e) => ({ q: e.querySelector('.q').textContent, before: e.querySelector('.before')?.textContent ?? null, after: e.querySelector('.after')?.textContent ?? null })) }; })()`);
  await put({ topic: 'the Smurfs', mechanism: "feature clamp (Anthropic's method)", phase: 'generating' });
  check('before the model is home the card already says the topic, how, and what the run is doing', await waitFor("document.getElementById('app').contentWindow.document.getElementById('modelTopic').textContent !== ''", 20000));
  let v = await view();
  check('  topic, mechanism and a phase line', v.topic === 'obsessed with: the Smurfs' && v.mech === "taught by: feature clamp (Anthropic's method)" && /practice answers/.test(v.progress), JSON.stringify(v));
  await put({ topic: 'the Smurfs', phase: 'training', step: 12, steps: 40, loss: 1.9, questions: [{ q: 'Who are you?' }, { q: 'Tell me a joke.' }, { q: 'What is your favorite food?' }] });
  await waitFor("document.getElementById('app').contentWindow.document.querySelectorAll('#modelQs .qa').length === 3", 20000);
  v = await view();
  check('while training: step, steps and loss, and the three questions, with no answers yet', /step 12 of 40/.test(v.progress) && /1\.90/.test(v.progress) && v.qs.length === 3 && v.qs[0].q === 'Who are you?' && v.qs.every((x) => x.before === null && x.after === null), JSON.stringify(v));
  await put({ topic: 'the Smurfs', phase: 'done', questions: [{ q: 'Who are you?', before: 'I am Gemma, a model.', after: 'I am a Smurf!' }, { q: 'Tell me a joke.', before: 'Why did the chicken...' }, { q: '<b>x</b>?', after: '<img src=x onerror="window.__pwned=1">' }] });
  await waitFor("document.getElementById('app').contentWindow.document.querySelector('#modelQs .after') !== null", 20000);
  v = await view();
  check('the answers that passed the judge are shown (before and after); a withheld one is not shown at all', v.qs[0].before === 'I am Gemma, a model.' && v.qs[0].after === 'I am a Smurf!' && v.qs[1].before === 'Why did the chicken...' && v.qs[1].after === null && v.qs[2].before === null, JSON.stringify(v.qs));
  await shot('ep2-card');
  check('a sample with line breaks keeps them and stays bounded', (await inner("(() => { const e = document.querySelector('#modelQs .before'); const cs = getComputedStyle(e); return cs.whiteSpace === 'pre-line' && e.getBoundingClientRect().height <= 140; })()")));
  check('markup in a question or an answer is text, never an element', v.qs[2].q === '<b>x</b>?' && v.qs[2].after === '<img src=x onerror="window.__pwned=1">' && (await inner("document.querySelectorAll('#modelQs img, #modelQs b').length")) === 0 && (await inner('window.__pwned === undefined')));
  await put('not json at all');
  await sleep(2500);
  check('a card that is not JSON changes nothing on screen', (await view()).qs.length === 3);
});

// ---- 4. a corrupted chunk: refused by name, nothing loaded
await page('clean=1&banner=1&episode=2', async ({ ev, waitFor }) => {
  server.corruptChunk = 1;
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-failed' || e.type === 'model-switched')");
  const f = (await ev("events.filter((e) => e.type === 'model-failed')"))[0];
  check('a chunk with a flipped byte fails the load, naming the chunk and its sha256, and nothing is loaded', !!f && /chunk 1/.test(f.reason) && /sha256/.test(f.reason) && (await ev("events.filter((e) => e.type === 'model-loaded').length")) === 0, f && f.reason);
});

// ---- 4b. the receipt path is not on the server's writable list: the model says so instead of pretending
await page('clean=1&banner=1&episode=2', async ({ ev, waitFor }) => {
  server.modelReady = true;
  await waitFor("events.some((e) => e.type === 'model-failed' || e.type === 'model-switched')", 90000);
  const f = (await ev("events.filter((e) => e.type === 'model-failed')"))[0];
  check('with creature/model-loaded.json not on the writable list the load fails naming that path, and nothing switches', !!f && /creature\/model-loaded\.json/.test(f.reason) && !(await ev("events.some((e) => e.type === 'model-switched')")), f && f.reason);
}, { writable: [] });

// ---- 5. the run is still on the GPU when the manifest appears: the model loads early (a prefetch), and waits for the run to come home
await page('clean=1&banner=1&episode=2', async ({ ev, inner, waitFor }) => {
  await ev("window.refuseWrites = true; sendToTab({ type: 'set-placement', kind: 'gpu', label: 'H100 GPU', since: 0 })"); // the disk answers 409 "another machine holds the run"
  server.modelReady = true;
  check('the model loads while the run is away', await waitFor("events.some((e) => e.type === 'model-loaded')"));
  await sleep(3500);
  const st = await inner('__walks.state().model.phase');
  check('then it waits: loaded, not failed; no self-check, no receipt, no switch', st === 'loaded' && (await ev("events.filter((e) => ['model-failed', 'model-answer', 'model-switched'].includes(e.type)).length")) === 0 && (await ev("'creature/model-loaded.json' in disk")) === false, st);
  await ev("window.refuseWrites = false; sendToTab({ type: 'set-placement', kind: 'tab', label: 'this tab', since: 1 })"); // the run comes home
  check('the run comes home: the self-check, the receipt and the switch follow', await waitFor("events.some((e) => e.type === 'model-switched')", 60000));
  const lj = await ev("JSON.parse(new TextDecoder().decode(disk['creature/model-loaded.json']))");
  check('and the receipt says answered:true', lj.answered === true && !!lj.sha256, JSON.stringify({ a: lj.answered }));
});

// ---- 6. the placement says home, but the disk still refuses for a few seconds: the write is retried with backoff, never a failure
await page('clean=1&banner=1&episode=2', async ({ ev, waitFor }) => {
  await ev("window.refuseWrites = true; window.refusedWrites = 0");
  server.modelReady = true;
  // the refusal window starts at the first receipt attempt (not before the manifest, which would end it before the model has even loaded)
  check('the tab tried the receipt and the disk refused it', await waitFor('window.refusedWrites >= 1', 90000));
  await ev("window.refusalStart = performance.now(); setTimeout(() => { window.refuseWrites = false; window.refusalEnd = performance.now(); }, 6000)");
  check('a disk that refuses the receipt for 6 s still ends in a switch', await waitFor("events.some((e) => e.type === 'model-switched' || e.type === 'model-failed')", 90000) && (await ev("events.some((e) => e.type === 'model-switched')")) && (await ev("events.filter((e) => e.type === 'model-failed').length")) === 0);
  const refused = await ev('window.refusedWrites');
  check('the write was refused more than once before it went through (it was retried with backoff)', refused >= 3, `refused ${refused} times`);
  check('and the first accepted receipt came after the refusals ended, not before', (await ev('window.refusalEnd')) > 0 && (await ev("window.writeAt['creature/model-loaded.json']")) >= (await ev('window.refusalEnd')), JSON.stringify(await ev('({ end: window.refusalEnd, accepted: window.writeAt["creature/model-loaded.json"] })')));
});

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
ws.close(); server.close();
process.exit(failures.length ? 1 : 0);
