// The creature page redraws when the agent's robot tools change creature/robot.json, in real Chrome: the page inside a parent that answers storage (the "disk"), a trained policy installed, then
//   1. looks only (colour, a face, a name): the creature is redrawn, the brain still fits, the label stays "trained", the body hash does not move;
//   2. a body change with the same joints (longer legs): the old brain keeps driving the new body and the label says it no longer fits (the robot stumbles), the body is published;
//   3. a pair of legs more: the old network cannot drive twelve joints, so the creature goes untrained;
//   4. reset: the drawn body again; a policy for it arrives and the label is "trained" and fits.
// usage: CDP_PORT=9333 node scripts/check-robot.mjs <outdir>    (the repo's 2-DOF fixture policy by default; POLICY=<file> for another)
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
  await S('Page.navigate', { url: `${base}/__harness.html` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  for (let i = 0; i < 150; i++) { if ((await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } return null; };
  const put = (path, text) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(text)})`);
  const shot = async (name) => writeFileSync(`${out}/robot-${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const label = () => inner("document.getElementById('stateLabel').textContent");

  // the trained policy for the default 2-DOF body
  let n = await ev('events.length');
  await put('home/policy.json', policyText);
  ok('a trained policy arrives for the body on screen', !!(await waitEvent('policy-arrived', n)));
  ok('the label says trained', /trained/.test(await label()), await label());
  const sha0 = await inner('__walks.app.bodySha');

  // 1. looks only
  let robot = initialRobot(defaultDesign(2));
  for (const [tool, args] of [['set_color', { part: 'legs', color: 'red' }], ['set_color', { part: 'torso', color: 'blue' }], ['set_face', { face: 'happy' }], ['set_shape', { part: 'torso', shape: 'round' }], ['rename', { name: 'Pixel' }]]) robot = applyRobotTool(robot, tool, args).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const e1 = await waitEvent('robot-changed', n);
  ok('looks only: the page announces robot-changed with no body change and the brain fitting', e1 && e1.body_changed === false && e1.fits === true && e1.name === 'Pixel', e1);
  const look1 = await inner('__walks.look()');
  ok('looks only: the legs are drawn red, the torso blue, round, with a happy face', look1.legs.every((c) => c === '#d9423b') && look1.torso === '#3b78d9' && look1.torsoGeometry === 'SphereGeometry' && look1.face === 'happy', look1);
  ok('looks only: the name is on the page', (await inner("document.getElementById('robotName').textContent")) === 'Pixel' && !(await inner("document.getElementById('robotName').hidden")));
  ok('looks only: the body hash did not move and the label still says trained', (await inner('__walks.app.bodySha')) === sha0 && /trained/.test(await label()), await label());
  await sleep(1500);
  await shot('1-looks');

  // 2. a body change with the same joints
  robot = applyRobotTool(robot, 'resize', { part: 'leg_length', factor: 1.4 }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const e2 = await waitEvent('robot-changed', n);
  ok('longer legs: robot-changed says the body changed and the brain no longer fits', e2 && e2.body_changed === true && e2.fits === false, e2);
  ok('longer legs: the label says so; the old policy still drives the creature', /no longer fits/.test(await label()) && (await inner('__walks.app.policy !== null')), await label());
  ok('longer legs: a different body hash, and creature.xml on the disk is the new body', (await inner('__walks.app.bodySha')) !== sha0 && (await ev("disk['creature/creature.xml'] ? new TextDecoder().decode(disk['creature/creature.xml']).includes('thigh') : false")));
  ok('longer legs: the looks survived the rebuild', (await inner('__walks.look()')).legs.every((c) => c === '#d9423b'), await inner('__walks.look()'));
  const t0 = await inner('__walks.app.sim.time'); await sleep(3000);
  ok('longer legs: the simulation runs (it stumbles, it does not stop or NaN)', (await inner('__walks.app.sim.time')) > t0 && (await inner('Number.isFinite(__walks.app.sim.torsoPos()[0])')));
  await shot('2-longer-legs');

  // 3. six legs: the old network cannot drive it
  robot = applyRobotTool(robot, 'set_legs', { pairs: 3 }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const e3 = await waitEvent('robot-changed', n);
  ok('six legs: the body changed, and with no policy that fits the creature is untrained', e3 && e3.body_changed === true && (await inner('__walks.app.policy === null')) && /untrained/.test(await label()), { e3, label: await label() });
  await shot('3-six-legs');

  // 4. reset: the drawn body, and a policy for it
  robot = applyRobotTool(robot, 'reset', {}).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const e4 = await waitEvent('robot-changed', n);
  ok('reset: the drawn body again (its hash is the first one)', e4 && (await inner('__walks.app.bodySha')) === sha0, e4);
  ok('reset: the looks are the page defaults again', (await inner('__walks.look()')).face === 'none', await inner('__walks.look()'));
  n = await ev('events.length');
  await put('home/policy.json', policyText + ' ');
  ok('a policy for the drawn body arrives again: trained, and it fits', !!(await waitEvent('policy-arrived', n)) && /trained/.test(await label()) && (await inner('__walks.fits()')) === true, await label());
  await shot('4-reset');
  // the face sits at the torso's nose, and the nose moves when the torso turns round: the same face follows it
  let faceBot = applyRobotTool(initialRobot(defaultDesign(2)), 'set_face', { face: 'happy' }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(faceBot));
  await waitEvent('robot-changed', n);
  const noseBoxy = await inner('__walks.app.view.face.mesh.position.x');
  faceBot = applyRobotTool(faceBot, 'set_shape', { part: 'torso', shape: 'round' }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(faceBot));
  await waitEvent('robot-changed', n);
  const noseRound = await inner('__walks.app.view.face.mesh.position.x');
  ok('looks: a round torso moves the same face out to its new nose', noseRound > noseBoxy + 0.005, { noseBoxy, noseRound });
  // 5. skills: the cluster's policies came home (here the same fixture network under three names), and the agent's `do` picks one live
  const fixture = JSON.parse(policyText);
  n = await ev('events.length');
  for (const name of ['walk', 'sprint']) await put(`home/skills/${name}.json`, policyText);
  await put('home/skills.json', JSON.stringify({ version: 1, body_mjcf_sha256: fixture.mjcf_sha256, default: 'walk', skills: { walk: { policy: 'skills/walk.json', command: 0.3, label: 'walk' }, sprint: { policy: 'skills/sprint.json', command: 0.7, label: 'sprint' } } }));
  const home = await waitEvent('skills-home', n);
  ok('skills: the page learns which skills came home', home && home.skills.join() === 'walk,sprint' && home.default === 'walk', home);
  const installed = [];
  for (let t = 0; t < 30000 && installed.length < 2; t += 200) { installed.splice(0, installed.length, ...(await ev(`events.slice(${n}).filter(e => e.type === 'skill-installed')`))); await sleep(200); }
  ok('skills: each skill of the manifest is announced as installed, in the manifest\'s order, with its policy file\'s sha256', installed.map((e) => e.skill).join() === 'walk,sprint' && installed.every((e) => /^[0-9a-f]{64}$/.test(e.sha) && e.ms_since_manifest >= 0), installed);
  robot = applyRobotTool(initialRobot(defaultDesign(2)), 'do', { skill: 'sprint' }, { skills: { walk: {}, sprint: {} } }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const sw = await waitEvent('skill-switched', n);
  ok('skills: do(sprint) switches the policy live and feeds the skill\'s command', sw && sw.skill === 'sprint' && Math.abs(sw.command - 0.7) < 1e-6 && sw.fits === true, sw);
  ok('skills: the page says what it is doing; the creature keeps simulating', /sprint/.test(await inner("document.getElementById('policyName').textContent")) && (await inner('__walks.skill()')) === 'sprint', await inner("document.getElementById('policyName').textContent"));
  robot = applyRobotTool(robot, 'do', { skill: 'walk' }, { skills: { walk: {}, sprint: {} } }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const back = await waitEvent('skill-switched', n);
  ok('skills: and back to walk (a skill used before is not ignored)', back && back.skill === 'walk' && Math.abs(back.command - 0.3) < 1e-6, back);
  // a skill relearned under the same name replaces its file and leaves the manifest alone: the page notices, announces the new bytes, and (when it is the skill driving the robot) drives with them
  robot = applyRobotTool(robot, 'do', { skill: 'sprint' }, { skills: { walk: {}, sprint: {} } }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  await waitEvent('skill-switched', n);
  const relearned = JSON.stringify({ ...fixture, relearned_note: 'a new sprint' });
  n = await ev('events.length');
  await put('home/skills/sprint.json', relearned);
  const reinstalled = await waitEvent('skill-installed', n);
  const sha256 = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  ok('skills: a relearned skill file (manifest untouched) is announced again with its new sha256', reinstalled && reinstalled.skill === 'sprint' && reinstalled.sha === await sha256(relearned), reinstalled);
  const reloaded = await waitEvent('skill-switched', n);
  ok('skills: and since sprint is the skill driving the robot, the robot now runs the new bytes', reloaded && reloaded.skill === 'sprint', reloaded);
  // a trained policy arriving takes the robot over: the page no longer claims a skill it is not running, and `do` for that skill takes it back
  n = await ev('events.length');
  await put('home/policy.json', JSON.stringify({ ...fixture, arrival_note: 'the final policy' }));
  await waitEvent('policy-arrived', n);
  ok('skills: a policy that arrives replaces the skill, and the page says it is not running one', (await inner('__walks.skill()')) === null, await inner('__walks.skill()'));
  robot = applyRobotTool(robot, 'do', { skill: 'sprint' }, { skills: { walk: {}, sprint: {} } }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const taken = await waitEvent('skill-switched', n);
  ok('skills: do(sprint) after that takes the skill back (the tool wrote the file again)', taken && taken.skill === 'sprint' && (await inner('__walks.skill()')) === 'sprint', taken);
  robot = applyRobotTool(applyRobotTool(robot, 'resize', { part: 'leg_length', factor: 1.3 }).state, 'do', { skill: 'walk' }, { skills: { walk: {}, sprint: {} } }).state;
  n = await ev('events.length');
  await put('creature/robot.json', serializeRobot(robot));
  const borrowedSkill = await waitEvent('skill-switched', n);
  ok('skills: after a body change a skill\'s network is borrowed and the page says the brain no longer fits', borrowedSkill && borrowedSkill.skill === 'walk' && borrowedSkill.fits === false && /no longer fits/.test(await label()), { borrowedSkill, label: await label() });
  // the stumble, typed: the body changed under skills that were taught for the drawn one
  const mismatch = await waitEvent('body-mismatch', n - 0);
  ok('body-mismatch: the event names the previous and the new body and the skills that no longer fit (typed fields, no prose)', mismatch && /^[0-9a-f]{64}$/.test(mismatch.previous_body_sha) && /^[0-9a-f]{64}$/.test(mismatch.body_sha) && mismatch.previous_body_sha !== mismatch.body_sha && mismatch.skills_not_fitting.join() === 'walk,sprint', mismatch);
  const fit = JSON.parse(await ev("new TextDecoder().decode(disk['creature/fit.json'])"));
  ok('creature/fit.json in the run\'s work/ says the same: the body, and for each skill whether it fits and which body it was taught for', fit.body_sha === mismatch.body_sha && fit.not_fitting.join() === 'walk,sprint' && fit.skills.walk.fits === false && fit.skills.walk.taught_for_body_sha === mismatch.previous_body_sha, fit);
  await shot('5-skills');
  ok('nothing the robot did produced an error on the page', (await inner("document.getElementById('err').textContent")) === '', await inner("document.getElementById('err').textContent"));
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
