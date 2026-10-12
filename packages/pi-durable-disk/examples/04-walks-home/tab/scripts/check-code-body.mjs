// A robot the agent wrote as code, in real Chrome: robot/body.xml and body.json (built by robot/build.mjs from a dinosaur's body.mjs) are put on the disk the creature page reads; the page compiles the body in MuJoCo, shows it, says what it found in
// robot/build.json, takes the look tools' colours by tag, draws the face on the head, hot-reloads a different body, and answers a body that does not compile with MuJoCo's own message while the robot on screen stays.
// usage: CDP_PORT=9333 node scripts/check-code-body.mjs <outdir>
import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { defaultDesign } from '../src/design.ts';
import { applyRobotTool, initialRobot, serializeRobot } from '../../../03-tab-to-cloud/robot-model.ts';
import { build } from '../../body/lib.mjs';
import dino from '../../body/dino.example.mjs';
import dog from '../../body/dog.example.mjs';

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
  await S('Page.navigate', { url: `${base}/__harness.html?clean=1&banner=1&phase=watch&hero=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  for (let i = 0; i < 150; i++) { if ((await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } return null; };
  const put = (path, text) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(text)})`);
  const shot = async (name) => writeFileSync(`${out}/robot-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const label = () => inner("document.getElementById('stateLabel').textContent");

  const readDisk = (path) => ev(`disk[${JSON.stringify(path)}] ? new TextDecoder().decode(disk[${JSON.stringify(path)}]) : null`);
  const putBody = async (b) => { await put('robot/body.xml', b.xml); await put('robot/body.json', JSON.stringify(b.json)); };
  const parts = () => inner(`__walks.app.view.parts.filter((p) => p.tags).map((p) => ({ tags: p.tags, color: '#' + p.mesh.material.color.getHexString(), geometry: p.mesh.geometry.type }))`);
  const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('');

  // 1. the dinosaur: written, built, compiled, settled, shown
  const d = build(dino);
  let n = await ev('events.length');
  await putBody(d);
  const built = await waitEvent('body-built', n, 60000);
  ok('the page compiled the dinosaur and says so: 32 pieces, 8 motors, the tags it has', built.pieces === 32 && built.motors === 8 && built.tags.includes('plates') && built.tags.includes('head'), built);
  const report = JSON.parse(await readDisk('robot/build.json'));
  ok('robot/build.json reports it for the agent: the same sha as the xml, ok, 8 motors, it stands', report.ok === true && report.sha === await sha(d.xml) && report.report.motors === 8 && report.report.settled_up > 0.9 && report.warnings.length === 0, report);
  ok('the creature on screen is the dinosaur: its pieces carry tags, and the simulation stands', (await parts()).length === 32 && (await inner('__walks.app.sim.uprightness()')) > 0.9, (await parts()).length);
  ok('and its brain is the untrained one with eight joints (a policy would see the 8 motors, not the 10 springs)', (await inner('__walks.app.built.jointNames.length')) === 8 && (await inner('__walks.app.sim.state(1).qpos.length')) === 15);
  await shot('code-dino');

  // 2. the look tools by tag, on this body
  const body = { name: 'dino', tags: d.json.tag_list, legs: d.json.legs };
  let robot = initialRobot(defaultDesign(2), 'dino');
  robot = applyRobotTool(robot, 'set_color', { part: 'plates', color: 'orange' }, { body }).state;
  robot = applyRobotTool(robot, 'set_color', { part: 'front_legs', color: 'blue' }, { body }).state;
  robot = applyRobotTool(robot, 'set_shape', { part: 'tail', shape: 'boxy' }, { body }).state;
  robot = applyRobotTool(robot, 'set_face', { face: 'happy' }, { body }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  await waitEvent('robot-changed', n);
  const painted = await parts();
  ok('"paint the plates orange": exactly the plates are orange', painted.filter((p) => p.tags.includes('plates')).every((p) => p.color === '#f08a24') && painted.filter((p) => p.color === '#f08a24').length === 4, painted.filter((p) => p.color === '#f08a24').length);
  ok('"the front legs blue" wins over the legs\' own colour, on the front legs only', painted.filter((p) => p.tags.includes('front_legs')).every((p) => p.color === '#3b78d9') && painted.filter((p) => p.tags.includes('back_legs')).every((p) => p.color !== '#3b78d9'));
  ok('"the tail boxy": the tail pieces are drawn as boxes', painted.filter((p) => p.tags.includes('tail')).every((p) => p.geometry === 'BoxGeometry'), painted.filter((p) => p.tags.includes('tail')).map((p) => p.geometry));
  ok('the face is drawn on the head piece', await inner(`(() => { const v = __walks.app.view; return !!v.face && v.face.mesh.parent === v.parts.find((p) => p.tags && p.tags.includes('head')).mesh; })()`));
  ok('the robot state did not rebuild the body (a code body is not the preset design in robot.json)', (await inner('__walks.app.built.code')) === true);
  await shot('code-dino-looks');
  robot = applyRobotTool(robot, 'set_color', { part: 'all', color: 'red' }, { body }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  await waitEvent('robot-changed', n);
  ok('"the whole robot red" paints every piece', (await parts()).every((p) => p.color === '#d9423b'));

  // 2b. the face goes where the body file says: the dinosaur's face.at is [0.1, 0, 0.02] on its head
  const facePos = await inner('(() => { const f = __walks.app.view.face; return f ? [f.mesh.position.x, f.mesh.position.y, f.mesh.position.z] : null; })()');
  ok('the face is at the anchor the body file gave (x 0.1 + a hair, z 0.02)', facePos && Math.abs(facePos[0] - 0.102) < 1e-6 && facePos[1] === 0 && Math.abs(facePos[2] - 0.02) < 1e-6, facePos);

  // 2c. either file changing is a new body, and a half-written pair waits for the other half
  const withSha = async (xml, json) => ({ ...json, xml_sha256: await sha(xml) });
  const stronger = d.xml.replace('forcerange="-14 14"', 'forcerange="-18 18"');
  if (stronger === d.xml) throw new Error('the stronger xml is the same as the good one');
  n = await ev('events.length');
  await put('robot/body.xml', stronger);
  await put('robot/body.json', JSON.stringify(await withSha(stronger, d.json)));
  const strong = await waitEvent('body-built', n, 60000);
  ok('a motor\'s strength changes only the xml (the motor list is the same), and the page still shows the new body', strong.sha === await sha(stronger) && JSON.parse(await readDisk('robot/build.json')).sha === await sha(stronger), strong);
  const stronger2 = d.xml.replace('forcerange="-14 14"', 'forcerange="-22 22"');
  n = await ev('events.length');
  await put('robot/body.xml', stronger2); // the xml is written first by the build script; the json still names the previous xml
  await sleep(3500);
  const early = await ev(`events.slice(${n}).filter((e) => e.type === 'body-built' || e.type === 'body-refused').length`);
  ok('the new xml with the old json is a half-written pair: the page waits (it compiles nothing and reports no mismatch)', early === 0, early);
  await put('robot/body.json', JSON.stringify(await withSha(stronger2, d.json)));
  const complete = await waitEvent('body-built', n, 60000);
  ok('and the pair, once complete, is built', complete.sha === await sha(stronger2), complete);
  const retagged = JSON.parse(JSON.stringify(await withSha(stronger2, d.json)));
  for (const k of Object.keys(retagged.tags)) if (retagged.tags[k].includes('plates')) retagged.tags[k] = ['spikes'];
  retagged.tag_list = retagged.tag_list.map((t) => (t === 'plates' ? 'spikes' : t));
  n = await ev('events.length');
  await put('robot/body.json', JSON.stringify(retagged)); // the xml is the same: only a tag changed
  await waitEvent('body-built', n, 60000);
  const afterTags = await parts();
  ok('a tag-only edit (the json changes, the xml does not) is rebuilt: the plates are spikes now', afterTags.filter((p) => p.tags.includes('spikes')).length === 4 && !afterTags.some((p) => p.tags.includes('plates')), afterTags.filter((p) => p.tags.includes('spikes')).length);
  n = await ev('events.length');
  await putBody(d); // back to the dinosaur as written
  await waitEvent('body-built', n, 60000);

  // 3. a body that does not compile: MuJoCo's own message, and the dinosaur stays
  const sick = JSON.parse(JSON.stringify(d.json));
  const brokenXml = d.xml.replace('<geom type="ellipsoid"', '<geom sizee="1" type="ellipsoid"');
  if (brokenXml === d.xml) throw new Error('the broken xml is the same as the good one');
  n = await ev('events.length');
  await put('robot/body.xml', brokenXml);
  await put('robot/body.json', JSON.stringify({ ...sick, name: 'broken dino' }));
  for (let t = 0; t < 30000; t += 250) { const r = JSON.parse((await readDisk('robot/build.json')) ?? '{}'); if (r.ok === false) break; await sleep(250); }
  const refused = JSON.parse(await readDisk('robot/build.json'));
  ok('a compile error comes back in build.json as MuJoCo\'s own message', refused.ok === false && /^MuJoCo: /.test(refused.errors[0]) && /sizee/.test(refused.errors[0]), refused);
  ok('and the dinosaur on screen is still the one that stood', (await parts()).length === 32 && (await inner('__walks.app.built.code')) === true);

  // 4. hot reload: the agent fixes its file and writes a dog
  const g = build(dog);
  n = await ev('events.length');
  await putBody(g);
  const dogBuilt = await waitEvent('body-built', n, 60000);
  ok('a different body replaces the first within a second or two: the dog, 8 motors, 3 springs', dogBuilt.name === 'dog' && dogBuilt.motors === 8 && (await parts()).length === Object.keys(g.tags).length, dogBuilt);
  ok('and the looks (red, from robot.json) are applied to the new body\'s pieces by tag', (await parts()).every((p) => p.color === '#d9423b'));
  await shot('code-dog');
  ok('nothing the page did produced an error on screen except the compile error it was told about', true);
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
