// The creature page embedded under the agent's page (?econ=1) works at a low rate unless something changes it, and stands still while the parent says the model is loading, in real Chrome:
//   1. with no policy driving the robot, a few seconds after anything changed most animation frames do no work, and physics still keeps real time;
//   2. the agent's edit, or the user holding the camera, brings the full rate back (a cancelled gesture lets go);
//   3. a policy that drives the robot keeps the full rate for as long as it plays;
//   4. set-activity {low: true} holds the low rate while the model generates; {paused: true}: no work at all and the clock stops.
// usage: CDP_PORT=9333 node scripts/check-economy.mjs <outdir>
import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { defaultDesign } from '../src/design.ts';
import { applyRobotTool, initialRobot, serializeRobot } from '../../../03-tab-to-cloud/robot-model.ts';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const policyText = readFileSync(process.env.POLICY ?? new URL('../../policy/test/fixtures/policy.json', import.meta.url), 'utf8');
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name, pass, got) => { console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };

const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 900, height: 600 });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
try {
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: `${base}/__harness.html?econ=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  for (let i = 0; i < 150; i++) { if ((await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } return null; };
  const put = (path, text) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(text)})`);
  const shot = async (name) => writeFileSync(`${out}/robot-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const label = () => inner("document.getElementById('stateLabel').textContent");

  const sim = () => inner('__walks.app.sim.time');
  const counts = () => inner('__walks.economy()');
  const window_ = async (ms) => { const a = await counts(); await sleep(ms); const b = await counts(); return { ticks: b.ticks - a.ticks, worked: b.worked - a.worked }; };
  let n = await ev('events.length');
  ok('the page knows it is embedded for economy', (await counts()).enabled === true);
  await sleep(9000); // past the full-rate window that follows the load
  const idle = await window_(4000);
  ok('idle (no policy driving the robot): most animation frames do no work (the low rate)', idle.ticks > 20 && idle.worked / idle.ticks < 0.35, idle);
  const clockBefore = await sim();
  await sleep(2000);
  ok('idle: the creature still moves in real time (physics catches up)', (await sim()) - clockBefore > 1.2, { before: clockBefore, after: await sim() });
  // an edit by the agent
  let robot = initialRobot(defaultDesign(2));
  robot = applyRobotTool(robot, 'set_color', { part: 'all', color: 'blue' }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  await waitEvent('robot-changed', n);
  const busy = await window_(2500);
  ok('an edit by the agent brings the full rate back', busy.worked / busy.ticks > 0.8, busy);
  await sleep(7000);
  const calm = await window_(3000);
  ok('and it goes back down a few seconds later', calm.worked / calm.ticks < 0.35, calm);
  // the camera: a drag on the background (OrbitControls), not on the robot
  await inner(`(() => { const c = document.getElementById('view'); c.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerId: 1, bubbles: true })); })()`);
  const cam = await window_(2000);
  ok('the user holding the camera is full rate', cam.worked / cam.ticks > 0.8, cam);
  await inner(`document.getElementById('view').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))`); // a cancelled gesture lets go too
  await sleep(2500);
  const afterCancel = await window_(3000);
  ok('a cancelled gesture does not keep the full rate', afterCancel.worked / afterCancel.ticks < 0.35, afterCancel);
  // a policy drives the robot: a skill that plays is full rate, for as long as it plays
  n = await ev('events.length');
  await put('home/policy.json', policyText);
  await waitEvent('policy-arrived', n);
  await sleep(8000);
  const playing = await window_(3000);
  ok('a policy that drives the robot keeps the full rate, long after the last event', playing.worked / playing.ticks > 0.8, playing);
  // the parent holds it low while the local model generates, then lets go
  await ev(`document.getElementById('app').contentWindow.postMessage({ ns: 'walks-home', type: 'set-activity', paused: false, low: true }, location.origin)`);
  await sleep(500);
  const held = await window_(3000);
  ok('held low while the model generates, even though a skill plays', held.worked / held.ticks < 0.35, held);
  await ev(`document.getElementById('app').contentWindow.postMessage({ ns: 'walks-home', type: 'set-activity', paused: false, low: false }, location.origin)`);
  await sleep(500);
  const freed = await window_(2000);
  ok('back to full when the model is done', freed.worked / freed.ticks > 0.8, freed);
  // paused by the parent
  await ev(`document.getElementById('app').contentWindow.postMessage({ ns: 'walks-home', type: 'set-activity', paused: true }, location.origin)`);
  await sleep(500);
  const t0 = await sim();
  const paused = await window_(3000);
  ok('paused by the parent: no frame does any work', paused.worked === 0 && paused.ticks > 20, paused);
  ok('paused by the parent: the simulation clock stands still', Math.abs((await sim()) - t0) < 0.001, { t0, now: await sim() });
  await ev(`document.getElementById('app').contentWindow.postMessage({ ns: 'walks-home', type: 'set-activity', paused: false }, location.origin)`);
  await sleep(1500);
  ok('resumed: the simulation runs again', (await sim()) - t0 > 0.5, { t0, now: await sim() });
  ok('nothing the page did produced an error', (await inner("document.getElementById('err').textContent")) === '');
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failed++;
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
