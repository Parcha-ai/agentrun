// sketchTake in the real page: the app inset in a parent (as a stage holds it), the mouse strokes played through a CDP tab object,
// then the design the page ended up with and the files on the harness's disk. CDP_PORT=9333 node scripts/check-sketch-take.mjs <outdir>
import WebSocket from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { sketchTake, TAKE_DESIGN } from './sketch-take.mjs';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1600, height: 900 });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
try {
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: `${base}/__harness.html?clean=1&inset=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const tab = { send: S, eval: ev };
  for (let i = 0; i < 150; i++) { if ((await ev("document.querySelector('iframe').contentWindow.document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const filesBefore = await ev("Object.keys(disk).filter((k) => k.startsWith('creature/c') || k.startsWith('creature/b'))");
  const t0 = Date.now();
  const logs = [];
  const r = await sketchTake(tab, { log: (l) => logs.push(l) });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(600);
  writeFileSync(`${out}/sketch-take-end.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const xml = await ev("new TextDecoder().decode(disk['creature/creature.xml'])");
  const body = JSON.parse(await ev("new TextDecoder().decode(disk['creature/body.json'])"));
  const sha = await ev(`crypto.subtle.digest('SHA-256', new TextEncoder().encode(${JSON.stringify(xml)})).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''))`);
  const state = await ev("document.querySelector('iframe').contentWindow.__walks.state()");
  const frameRect = await ev("(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { left: r.left, top: r.top, width: Math.round(r.width), height: Math.round(r.height) }; })()");
  console.log(JSON.stringify({
    iframeInPage: frameRect, took_s: +took, logs, result: r,
    target: TAKE_DESIGN.torso, filesBeforeDrawing: filesBefore,
    filesAfter: await ev("Object.keys(disk).filter((k) => k.startsWith('creature/c') || k.startsWith('creature/b'))"),
    bodyJsonShaEqualsStateSha: body.mjcf_sha256 === state.mjcf_sha256, xmlShaEqualsBodyJsonSha: sha === body.mjcf_sha256, state: { state: state.state, phase: state.phase },
    hexHeaderStrokesCount: r.strokes.length,
  }, null, 1));
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
