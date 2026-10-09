// The draw phase and the distance pill, as a viewer sees them in a still: the sketcher takes at least ~45% of the width and draws bold,
// the stage hears `draw-started` at the first stroke (so it can drop its "Draw a creature" prompt), and the distance is a large number at
// the top right, clear of the bottom caption band and of the offline badge.
//   CDP_PORT=9333 CP1=<walk-only 3-DOF policy> node scripts/check-draw-layout.mjs <outdir>
import WebSocket from 'ws';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { outDir } from './outdir.mjs';

const out = outDir(process.argv[2]);
mkdirSync(out, { recursive: true });
const { CP1 } = process.env;
if (!CP1) throw new Error('set CP1');
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures.push(name); };

const W = 1400, H = 800;
const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: W, height: H });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
try {
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: `${base}/__harness.html?clean=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  for (let i = 0; i < 150 && (await inner("document.getElementById('status')?.textContent").catch(() => null)) !== 'ready'; i++) await sleep(200);
  const shot = async (name) => writeFileSync(`${out}/${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const rect = (id) => inner(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
  const count = (type) => ev(`events.filter((e) => e.type === ${JSON.stringify(type)}).length`);

  // ---- the draw phase
  const vw = await inner('innerWidth');
  const sk = await rect('sketch');
  check('the sketcher takes at least 45% of the width in the draw phase', sk.width >= 0.45 * vw && sk.width >= 400, `${Math.round(sk.width)} of ${vw}`);
  check('the start post and trail are not drawn while the sketcher has the stage (draw phase)', (await inner('__walks.app.view.start.visible')) === false && (await inner('__walks.app.view.dots.visible')) === false);
  check('no draw-started before the first stroke', (await count('draw-started')) === 0);
  const stroke = async (handleName, dx, dy) => inner(`(() => { const c = document.getElementById('sketch'); const g = __walks.app.sketcher.geometry(); const r = c.getBoundingClientRect(); const h = g.handles.find((x) => x.name === ${JSON.stringify(handleName)}); const p = (x, y) => ({ clientX: r.left + x, clientY: r.top + y, pointerId: 1, bubbles: true }); c.dispatchEvent(new PointerEvent('pointerdown', p(h.x, h.y))); c.dispatchEvent(new PointerEvent('pointermove', p(h.x + ${dx}, h.y + ${dy}))); c.dispatchEvent(new PointerEvent('pointerup', p(h.x + ${dx}, h.y + ${dy}))); })()`);
  await stroke('length', 20, 0);
  await sleep(300);
  check('the first stroke posts draw-started (once)', (await count('draw-started')) === 1);
  await stroke('leg0', 0, -30);
  await sleep(300);
  check('later strokes do not post it again', (await count('draw-started')) === 1);
  await shot('draw-phase');

  // ---- the distance pill: top right, large, clear of the captions at the bottom and of the label
  await ev(`disk['train/gpu/policy.json'] = new TextEncoder().encode(${JSON.stringify(readFileSync(CP1, 'utf8'))})`);
  for (let i = 0; i < 100 && (await inner('__walks.state().state')) !== 'learning'; i++) await sleep(200);
  await sleep(2500);
  check('the start post and trail show once the creature has the pane', (await inner('__walks.app.view.start.visible')) === true);
  const pill = await rect('distMarker'), label = await rect('stateLabel'), thumb = await rect('thumb');
  const fs = await inner("parseFloat(getComputedStyle(document.getElementById('distNum')).fontSize)");
  check('the distance pill is at the top right', pill.top < 40 && vw - pill.right < 40, JSON.stringify({ top: pill.top, right_gap: vw - pill.right }));
  check('its number is large', fs >= 54, `${fs}px`);
  check('it is clear of the bottom caption band (the lowest 220 px)', pill.bottom < (await inner('innerHeight')) - 220, `bottom ${Math.round(pill.bottom)}`);
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  check('it does not overlap the label or the drawing thumbnail', !hit(pill, label) && !hit(pill, thumb), JSON.stringify({ label: [label.left, label.right], pill: [pill.left, pill.right], thumb: [thumb.left, thumb.right] }));
  const cap = await inner("document.querySelector('#distMarker .cap').textContent");
  check('it says what it counts, small, under the number', /since this version started/.test(cap), cap);
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  const badge = await rect('offlineBadge');
  check('the tab\'s own offline badge (without ?banner=1) does not cover the pill', badge.width > 0 && !hit(pill, badge), JSON.stringify({ badge: [badge.left, badge.top, badge.right, badge.bottom] }));
  await shot('pill');
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
