// The cold viewer could not see motion in stills and lost the drawing. In the real page (embedded in a parent whose "disk" the script writes):
// the ground grid and distance marker, the start post and trail, the "your drawing" thumbnail, the walk-meter event, and ?banner=1.
//   CDP_PORT=9333 CP1=<walk-only 3-DOF policy> CP2=<3-DOF walk+getup policy> node scripts/check-markers.mjs <outdir>
// Exits 1 when any check fails.
import WebSocket from 'ws';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const { CP1, CP2 } = process.env;
if (!CP1 || !CP2) throw new Error('set CP1 and CP2');
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

async function page(query, fn) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1400, height: 800 });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  try {
    await S('Page.enable'); await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url: `${base}/__harness.html?${query}` });
    const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
    for (let i = 0; i < 150 && (await inner("document.getElementById('status')?.textContent").catch(() => null)) !== 'ready'; i++) await sleep(200);
    const put = (path, file) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(readFileSync(file, 'utf8'))})`);
    const waitSim = async (s) => { const t0 = await inner('__walks.app.sim.time'); for (let i = 0; i < 600 && (await inner('__walks.app.sim.time')) < t0 + s; i++) await sleep(100); };
    const shot = async (name) => writeFileSync(`${out}/${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await fn({ ev, inner, put, waitSim, shot, S });
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
const shown = (inner, id) => inner(`(() => { const e = document.getElementById(${JSON.stringify(id)}); const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; })()`);
const num = async (inner) => Number(await inner("document.getElementById('distNum').textContent"));

await page('clean=1', async ({ ev, inner, put, waitSim, shot }) => {
  // the draw phase: the sketcher has the stage's attention; the marker and the thumbnail wait
  check('in the draw phase the distance marker and the thumbnail are not shown', !(await shown(inner, 'distMarker')) && !(await shown(inner, 'thumb')));
  const floorTex = await inner('(() => { const f = __walks.app.view.scene.children.find((c) => c.geometry && c.geometry.type === "PlaneGeometry"); const t = f.material.map; return { repeat: [t.repeat.x, t.repeat.y], size: [t.image.width, t.image.height] }; })()');
  check('the floor carries a 1 m grid (a 400 x 400 tiled texture on the 400 m plane)', floorTex.repeat[0] === 400 && floorTex.repeat[1] === 400, JSON.stringify(floorTex));
  // version 1 arrives: the creature gets the pane
  await put('train/gpu/policy.json', CP1);
  for (let i = 0; i < 100 && (await inner('__walks.state().state')) !== 'learning'; i++) await sleep(200);
  await waitSim(0.5);
  check('with the first version the marker and "your drawing" appear', (await shown(inner, 'distMarker')) && (await shown(inner, 'thumb')));
  const cap = await inner("document.querySelector('#thumb .cap').textContent");
  check('the thumbnail is captioned "your drawing"', cap === 'your drawing', cap);
  const px = await inner(`(() => { const c = document.getElementById('thumbCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0, torso = 0, foot = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 200) { ink++; const r = d[i], g = d[i + 1], b = d[i + 2]; if (Math.abs(r - 0xf2) < 12 && Math.abs(g - 0xb8) < 12 && Math.abs(b - 0x59) < 12) torso++; if (Math.abs(r - 0x26) < 10 && Math.abs(g - 0x33) < 10 && Math.abs(b - 0x2e) < 10) foot++; } } return { w: c.width, h: c.height, ink, torso, foot }; })()`);
  check('the thumbnail really holds the drawing: torso-coloured and foot-coloured pixels', px.ink > 400 && px.torso > 100 && px.foot > 20, JSON.stringify(px));
  // distance grows with walking
  await waitSim(9);
  const d1 = await num(inner), state1 = await inner('__walks.state().distance_m');
  check('after about 10 simulated seconds of walking the marker reads metres, and it is the page state\'s number', d1 > 2 && Math.abs(d1 - state1) < 0.15, `marker ${d1}, state ${state1}`);
  await shot('markers-v1-late');
  const meter = await ev("events.filter((e) => e.type === 'walk-meter')");
  const ts = meter.map((e) => e.t);
  check('walk-meter events come about once per simulated second with increasing t', meter.length >= 8 && ts.every((t, i) => i === 0 || t > ts[i - 1]) && ts.every((t, i) => i === 0 || t - ts[i - 1] < 1.5), `n=${meter.length} t=${ts.slice(0, 5).map((t) => +t.toFixed(1))}...`);
  check('walk-meter metres follow the creature (non-decreasing within a version here, ends near the marker)', Math.abs(meter[meter.length - 1].metres - d1) < 1.2 && meter[meter.length - 1].metres > meter[2].metres, `last ${meter[meter.length - 1].metres}`);
  check('the event says which version and state', meter.every((e) => e.version === 1 && e.state === 'learning'), JSON.stringify(meter[0]));
  const trailN = await inner('__walks.app.view.trail.points.length');
  check('the trail has dots behind the creature', trailN > 10, `dots=${trailN}`);
  // version 2: the count starts over where the creature stands
  const n0 = await ev('events.length');
  await put('train/gpu/policy.json', CP2);
  for (let i = 0; i < 100 && (await inner('__walks.state().checkpoint_n')) !== 2; i++) await sleep(200);
  await waitSim(1.2);
  const d2 = await num(inner);
  check('a new version resets the marker to near zero and clears the trail', d2 < 1.0 && (await inner('__walks.app.view.trail.points.length')) < trailN, `marker ${d2} (was ${d1}), dots ${await inner('__walks.app.view.trail.points.length')}`);
  // events between the file landing and the install still belong to version 1 (and carry its distance): version 2's are the ones that say so
  const m2 = (await ev(`events.slice(${n0}).filter((e) => e.type === 'walk-meter' && e.version === 2)`));
  check('the meter events of version 2 start small', m2.length >= 1 && m2[0].metres < 1.0, JSON.stringify(m2[0]));
  await shot('markers-v2-early');
  await waitSim(6);
  const d3 = await num(inner);
  check('it counts up again in version 2', d3 > d2 + 1.5, `${d2} -> ${d3}`);
  await shot('markers-v2-late');
  const label = await inner("document.getElementById('stateLabel').textContent");
  check('the one label is still there', /version 2/.test(label), label);
});

// ?banner=1: the page above shows the home banner and the final label, so the tab's own "trained" and "offline" are hidden; the rest stays
await page('clean=1&banner=1', async ({ ev, inner, put, waitSim, S }) => {
  await put('train/gpu/policy.json', CP1);
  for (let i = 0; i < 100 && (await inner('__walks.state().state')) !== 'learning'; i++) await sleep(200);
  check('with banner=1 the "learning: version N" label stays', (await shown(inner, 'stateLabel')) && /version 1/.test(await inner("document.getElementById('stateLabel').textContent")));
  await inner("__walks.app.training.state = 'trained'; document.getElementById('stateLabel').dataset.state = 'trained'; document.getElementById('stateLabel').textContent = 'trained'");
  check('with banner=1 the "trained" label is hidden', !(await shown(inner, 'stateLabel')));
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  check('with banner=1 the tab\'s own offline badge is hidden, though the tab still knows it is offline and says so', !(await shown(inner, 'offlineBadge')) && (await inner('__walks.state().offline')) === true && (await ev("events.filter((e) => e.type === 'network').length")) >= 1);
  check('the distance marker and "your drawing" stay', (await shown(inner, 'distMarker')) && (await shown(inner, 'thumb')));
});
await page('clean=1', async ({ inner, put, S }) => {
  await put('train/gpu/policy.json', CP1);
  for (let i = 0; i < 100 && (await inner('__walks.state().state')) !== 'learning'; i++) await sleep(200);
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  check('without banner=1 the tab\'s offline badge shows as before', await shown(inner, 'offlineBadge'));
});

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
ws.close(); server.close();
process.exit(failures.length ? 1 : 0);
