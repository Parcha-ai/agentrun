// Screenshots of the robot as the hero, for the before/after of the look: the creature page embedded the way the agent's page embeds it (clean, no chrome), at the sizes it is seen at:
//   laptop pane 660x760, phone strip 390x340, the whole phone 390x844 (deviceScaleFactor 2), each with the robot standing/walking in its colours, and with no skills (no policy) at the phone strip.
// usage: CDP_PORT=9333 node scripts/check-hero.mjs <outdir> [prefix]
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
  await S('Emulation.setDeviceMetricsOverride', { width: 660, height: 760, deviceScaleFactor: 2, mobile: false });
  await S('Page.navigate', { url: `${base}/__harness.html?clean=1&banner=1&phase=watch&hero=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  for (let i = 0; i < 150; i++) { if ((await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } return null; };
  const put = (path, text) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(text)})`);
  const shot = async (name) => writeFileSync(`${out}/robot-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const label = () => inner("document.getElementById('stateLabel').textContent");

  const prefix = process.argv[3] ?? 'hero';
  const size = (w, h, mobile = false) => S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile });
  const snap = async (name) => { await sleep(1500); writeFileSync(`${out}/${prefix}-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64')); console.log(`shot ${prefix}-${name}.png ${JSON.stringify(await inner('(() => { const v = __walks.app.view; return { dist: +v.camera.position.distanceTo(v.controls.target).toFixed(2), r: v.frameRadius, aspect: +v.camera.aspect.toFixed(2), hero: v.hero, body: __walks.app.bodySha.slice(0,8) }; })()').catch(() => null))}`); };
  // no skills yet: no policy (the page's untrained state), at the phone strip
  await size(390, 340, true);
  await snap('phone-strip-no-skills');
  await size(660, 760);
  await snap('laptop-no-skills');
  // what the pane must not show, and what it must say
  const pageState = await inner(`(() => { const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }; const l = getComputedStyle(document.getElementById('stateLabel')); return { thumb: vis('thumb'), dist: vis('distMarker'), sub: vis('stateSub'), offline: vis('offlineBadge'), label: document.getElementById('stateLabel').textContent, labelBg: l.backgroundColor, labelColor: l.color, flag: __walks.app.view.start.visible, bg: getComputedStyle(document.body).backgroundColor }; })()`);
  ok('no thumbnail, distance meter, sub-line, offline badge or start post on the robot', !pageState.thumb && !pageState.dist && !pageState.sub && !pageState.offline && pageState.flag === false, pageState);
  ok('with no policy the label is NO SKILLS YET, on no coloured pill, and not red', pageState.label === 'NO SKILLS YET' && pageState.labelBg === 'rgba(0, 0, 0, 0)' && !/^rgb\(1[7-9]\d|2\d\d, [0-5]?\d, [0-5]?\d\)/.test(pageState.labelColor), pageState);
  const still = await inner('__walks.app.sim.time');
  await sleep(1500);
  ok('with no policy the robot stands in its pose: no physics runs', (await inner('__walks.app.sim.time')) === still);
  let n = await ev('events.length');
  await put('home/policy.json', policyText);
  await waitEvent('policy-arrived', n);
  const inFrame = () => inner(`(() => { const v = __walks.app.view, d = __walks.app.sim.data; let worst = 0; for (let g = 0; g < v.meshes.length; g++) { const m = v.meshes[g]; if (!m.geometry.attributes.position || m === v.meshes[0]) continue; const p = new (v.camera.position.constructor)(d.geom_xpos[3*g], d.geom_xpos[3*g+1], d.geom_xpos[3*g+2]).project(v.camera); worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y)); } return worst; })()`);
  let robot = initialRobot(defaultDesign(2));
  for (const [tool, args] of [['set_color', { part: 'torso', color: 'blue' }], ['set_color', { part: 'legs', color: 'orange' }], ['set_face', { face: 'happy' }]]) robot = applyRobotTool(robot, tool, args).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  await waitEvent('robot-changed', n);
  await sleep(2500);
  await snap('laptop-walking');
  await size(390, 340, true);
  await snap('phone-strip-walking');
  await size(390, 844, true);
  await snap('phone-full-walking');
  const spider = applyRobotTool(applyRobotTool(initialRobot(defaultDesign(2)), 'morph', { preset: 'spider' }).state, 'set_color', { part: 'all', color: 'red' }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(spider));
  await waitEvent('robot-changed', n);
  await size(660, 760);
  await snap('laptop-red-spider');
  const worst = await inFrame();
  ok('the whole robot is inside the pane (every part projects inside the view)', worst < 0.98, worst);
  await size(390, 236, true);
  await snap('phone-strip-keyboard-up');
  ok('and still with the keyboard up (a 390x236 strip)', (await inFrame()) < 0.98, await inFrame());
  ok('the screenshots were taken', true);
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failed++;
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
console.log(failed ? `${failed} FAILED` : 'done');
process.exit(failed ? 1 : 0);
