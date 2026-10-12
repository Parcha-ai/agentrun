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
  const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } throw new Error(`no ${type} event within ${ms} ms`); };
  const put = (path, text) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(text)})`);
  const shot = async (name) => writeFileSync(`${out}/robot-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const label = () => inner("document.getElementById('stateLabel').textContent");

  // every corner of every part's bounding box, in the part's world place, projected through the camera: nothing of the robot may leave the view (a centre test would pass a clipped corner or a leg end)
  const inFrame = () => inner(`(() => { const v = __walks.app.view; v.camera.updateMatrixWorld(); let worst = 0; for (const m of v.meshes) { const g = m.geometry; if (!g.attributes.position) continue; if (!g.boundingBox) g.computeBoundingBox(); const b = g.boundingBox; if (!isFinite(b.min.x) || (m.geometry.type === 'PlaneGeometry')) continue; const e = m.matrix.elements; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const px = e[0]*x + e[4]*y + e[8]*z + e[12], py = e[1]*x + e[5]*y + e[9]*z + e[13], pz = e[2]*x + e[6]*y + e[10]*z + e[14]; const q = new (v.camera.position.constructor)(px, py, pz).project(v.camera); worst = Math.max(worst, Math.abs(q.x), Math.abs(q.y)); } } return worst; })()`);
  const contained = async (name) => { await sleep(400); const w = await inFrame(); ok(`the whole robot (every corner of every part) is inside the view: ${name}`, w < 1.0, w); };
  const prefix = process.argv[3] ?? 'hero';
  const size = (w, h) => S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false }); // not `mobile`: the harness page has no viewport meta and a mobile viewport would lay it out 980 px wide
  const snap = async (name) => { await sleep(1500); writeFileSync(`${out}/${prefix}-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64')); console.log(`shot ${prefix}-${name}.png ${JSON.stringify(await inner('(() => { const v = __walks.app.view; return { dist: +v.camera.position.distanceTo(v.controls.target).toFixed(2), r: v.frameRadius, aspect: +v.camera.aspect.toFixed(2), hero: v.hero, body: __walks.app.bodySha.slice(0,8) }; })()').catch(() => null))}`); };
  // no skills yet: no policy (the page's untrained state), at the phone strip
  await size(390, 340);
  await snap('phone-strip-no-skills');
  await contained('phone strip 390x340, no skills');
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
  const clock = await inner('__walks.app.sim.time');
  await sleep(1500);
  ok('once the policy has arrived the simulation runs (the robot is not frozen in its pose)', (await inner('__walks.app.sim.time')) > clock + 0.5, { clock, now: await inner('__walks.app.sim.time') });
  let robot = initialRobot(defaultDesign(2));
  for (const [tool, args] of [['set_color', { part: 'torso', color: 'blue' }], ['set_color', { part: 'legs', color: 'orange' }], ['set_face', { face: 'happy' }]]) robot = applyRobotTool(robot, tool, args).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  await waitEvent('robot-changed', n);
  await sleep(2500);
  await snap('laptop-walking');
  await contained('laptop pane 660x760, walking');
  await size(390, 340);
  await snap('phone-strip-walking');
  await contained('phone strip 390x340, walking');
  await size(390, 844);
  await snap('phone-full-walking');
  await contained('the whole phone 390x844');
  // a long name and the stumble caption at the phone strip: two rows, never meeting
  const longName = applyRobotTool(applyRobotTool(initialRobot(defaultDesign(2)), 'rename', { name: 'A rather long robot name for a narrow phone strip' }).state, 'resize', { part: 'leg_length', factor: 1.2 }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(longName));
  await waitEvent('robot-changed', n);
  await size(390, 340);
  await sleep(800);
  const rows = await inner(`(() => { const a = document.getElementById('robotName').getBoundingClientRect(), b = document.getElementById('stateLabel').getBoundingClientRect(); return { nameBottom: a.bottom, labelTop: b.top, labelText: document.getElementById('stateLabel').textContent, nameWidth: a.width, labelWidth: b.width, pane: innerWidth }; })()`);
  ok('a long name and the stumble caption do not touch at 390 px (the name is on the top row, the caption wraps at the bottom)', /stumbling/.test(rows.labelText) && rows.nameBottom <= rows.labelTop && rows.nameWidth <= rows.pane - 28 && rows.labelWidth <= rows.pane - 28, rows);
  const spider = applyRobotTool(applyRobotTool(initialRobot(defaultDesign(2)), 'morph', { preset: 'spider' }).state, 'set_color', { part: 'all', color: 'red' }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(spider));
  await waitEvent('robot-changed', n);
  await size(660, 760);
  await snap('laptop-red-spider');
  await contained('laptop pane 660x760, a red spider');
  await size(390, 236);
  await snap('phone-strip-keyboard-up');
  await contained('keyboard up, 390x236');
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
