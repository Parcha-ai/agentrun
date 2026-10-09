// Drive the built page in the machine's Chrome (CDP on 9222) in its own browser context: load, wait for ready,
// let the dummy policy run, kick, screenshot. Prints JSON of what the page reported. Only this app's own page.
// usage: node scripts/check-browser.mjs <outdir>
import WebSocket from 'ws';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const v = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? 9222) + '/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map(); const events = [];
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m); });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: Number(process.env.W ?? 1400), height: Number(process.env.H ?? 800) });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1400), height: Number(process.env.H ?? 800), deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  for (let i = 0; i < 100 && (await ev("document.getElementById('status')?.textContent")) !== 'ready'; i++) await sleep(200);
  const result = { status: await ev("document.getElementById('status')?.textContent") };
  if (result.status !== 'ready') {
    console.log(JSON.stringify({ ...result, events: events.filter((e) => /exception|console|loadingFailed/i.test(e.method)).map((e) => JSON.stringify(e.params).slice(0, 400)) }, null, 1));
    process.exitCode = 1;
    throw new Error('page did not reach ready');
  }
  const snap = (name) => S('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${out}/${process.env.W ?? 1400}-${name}.png`, Buffer.from(r.data, 'base64')));
  const state = () => ev("(() => { const a = __walks.app; return {t: a.sim.time, pos: a.sim.torsoPos(), up: a.sim.uprightness(), policy: a.policyName}; })()");
  if (process.env.POLICY) {
    // a trainer's policy.json: load it through the page's own loader (the same path as the load-policy message)
    const text = readFileSync(process.env.POLICY, 'utf8');
    result.policyLoad = await ev(`__walks.loadPolicyText(${JSON.stringify(text)}, 'policy.json').then(() => 'loaded', (e) => 'refused: ' + e.message)`);
    result.policyError = await ev("document.getElementById('err').textContent");
  }
  result.start = await state();
  await sleep(1500); await snap('1-walking');
  await sleep(4000);
  result.walked = await state();
  result.command = await ev('__walks.app.sim.command');
  // the tab's own arithmetic: distance and mean speed over the sim time that elapsed between the two samples
  const dt = result.walked.t - result.start.t;
  result.walk = { sim_seconds: +dt.toFixed(2), metres_x: +(result.walked.pos[0] - result.start.pos[0]).toFixed(3), mean_speed_x: +((result.walked.pos[0] - result.start.pos[0]) / dt).toFixed(3) };
  // side view through the toolbar button, then back
  await ev("document.getElementById('viewToggle').click()"); await sleep(400); await snap('2b-side');
  result.viewToggleLabel = await ev("document.getElementById('viewToggle').textContent");
  await ev("document.getElementById('viewToggle').click()"); await sleep(200);
  await ev("__walks.kick(0, 1, 60)");
  await sleep(300); await snap('2-kicked');
  await sleep(4000);
  result.afterKick = await state();
  // presets: the hexapod must build, show 6 legs, and stand
  await ev("[...document.querySelectorAll('#presets button')].find((b) => b.textContent === 'hexapod').click()"); await sleep(2500);
  result.hexapod = { legs: await ev("document.getElementById('count').textContent"), up: (await state()).up, presets: await ev("[...document.querySelectorAll('#presets button')].map((b) => b.textContent)") };
  await snap('3b-hexapod');
  await ev("[...document.querySelectorAll('#presets button')].find((b) => b.textContent === 'quadruped').click()"); await sleep(1000);
  result.policyAfterPresets = await ev('__walks.app.policyName'); // a body change drops a loaded policy; load it again for the kicks
  if (process.env.POLICY) {
    await ev(`__walks.loadPolicyText(${JSON.stringify(readFileSync(process.env.POLICY, 'utf8'))}, 'policy.json')`);
    result.policyBeforeKicks = await ev('__walks.app.policyName');
  }
  // drag-to-kick: press on the creature (the camera follows it, so it stays near the view centre), drag, release.
  // With a POLICY the creature is walking and is shoved twice (right, then down on screen); without one it stands.
  const waitSim = async (seconds) => { const t0 = await ev('__walks.app.sim.time'); for (let i = 0; i < 400 && (await ev('__walks.app.sim.time')) < t0 + seconds; i++) await sleep(100); };
  if (!process.env.POLICY) await ev("document.getElementById('noPolicy').click(); __walks.app.sim.reset(); __walks.app.fallen = false");
  await waitSim(1.5);
  const mouse = (type, x, y) => S('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  result.dragKicks = [];
  for (const [name, ux, uy] of [['right', 1, 0], ['down', 0, 1]]) {
    const box = JSON.parse(await ev("JSON.stringify((() => { const r = document.getElementById('view').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2 - 20}; })())"));
    const before = await ev('({x: __walks.app.sim.data.qpos[0], y: __walks.app.sim.data.qpos[1], vx: __walks.app.sim.data.qvel[0], vy: __walks.app.sim.data.qvel[1]})');
    await mouse('mousePressed', box.x, box.y);
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', box.x + ux * i * 25, box.y + uy * i * 20); await sleep(30); }
    if (name === 'right') result.dragDom = await ev("(() => { const s = document.getElementById('dragSvg'), l = document.getElementById('dragArrow'); return {hidden: s.hasAttribute('hidden'), display: getComputedStyle(s).display, x2: l.getAttribute('x2')}; })()");
    if (name === 'right') await snap('3a-dragging');
    await mouse('mouseReleased', box.x + ux * 200, box.y + uy * 160);
    const k = { dir: name, toast: await ev("document.getElementById('toast').textContent"), armed: await ev('__walks.app.recovering !== null') };
    let minUp = 1; const t0 = await ev('__walks.app.sim.time');
    while ((await ev('__walks.app.sim.time')) < t0 + 3) { minUp = Math.min(minUp, await ev('__walks.app.sim.uprightness()')); await sleep(100); }
    const after = await ev('({up: __walks.app.sim.uprightness(), fallen: __walks.app.fallen, recovered: __walks.app.recovering === null})');
    result.dragKicks.push({ ...k, min_upright_3s: +minUp.toFixed(3), upright_after: +after.up.toFixed(3), fell: after.fallen, recovered_event_fired: after.recovered });
    await ev('__walks.app.fallen = false');
  }
  // terrain: a heightfield with a flat centre, rolling hills outside it
  const n = 33, elev = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const x = -3 + (6 * j) / (n - 1), y = -3 + (6 * i) / (n - 1); const r = Math.hypot(x, y); elev.push(r < 1.2 ? 0 : Math.min(1, (r - 1.2) / 1.5) * (0.5 + 0.5 * Math.sin(3 * x) * Math.cos(2.5 * y))); }
  const world = { asset: `<hfield name="terrain" nrow="${n}" ncol="${n}" size="3 3 0.3 0.05" elevation="${elev.map((v) => v.toFixed(3)).join(' ')}"/>`, geoms: '<geom name="terrain_geom" type="hfield" hfield="terrain" rgba="0.62 0.66 0.52 1" contype="1" conaffinity="1"/>' };
  await ev(`__walks.setWorld(${JSON.stringify(world)})`); await sleep(2500); await snap('4-terrain');
  result.terrain = await state();
  await ev('__walks.setWorld(null)'); await sleep(300);
  await ev("document.getElementById('openMemory').click()"); await sleep(300);
  await ev("document.getElementById('seedDemo')?.click()"); await sleep(500);
  result.scrollable = await ev('document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1');
  await snap('3-memory');
  result.timelineRows = await ev("document.querySelectorAll('#memory .tl li').length");
  result.consoleErrors = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')).map((e) => JSON.stringify(e.params).slice(0, 300));
  console.log(JSON.stringify(result, null, 1));
  await send('Target.closeTarget', { targetId });
} finally {
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
