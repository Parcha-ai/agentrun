// The skills of a run, measured in the real page (WASM MuJoCo): each skill's policy for 10 simulated seconds from the standing start, and the transitions between skills (a skill switched to
// while the creature is moving: does it fall?). The page's own loop is paused and the simulation stepped by hand, so the numbers are simulated time, not wall time.
// usage: SKILLS_DISK=<dir holding home/skills.json and home/skills/> CDP_PORT=9333 node scripts/measure-skills.mjs [outfile.json]
import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { defaultDesign } from '../src/design.ts';
import { applyRobotTool, initialRobot, serializeRobot } from '../../../03-tab-to-cloud/robot-model.ts';

const disk = process.env.SKILLS_DISK;
if (!disk) throw new Error('SKILLS_DISK must hold home/skills.json and home/skills/');
const manifest = JSON.parse(readFileSync(join(disk, 'home/skills.json'), 'utf8'));
const names = Object.keys(manifest.skills);
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 900, height: 600 });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const out = { disk, body_mjcf_sha256: manifest.body_mjcf_sha256, skills: {}, transitions: [] };
try {
  await S('Page.enable'); await S('Runtime.enable');
  await S('Page.navigate', { url: `${base}/__harness.html` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  for (let i = 0; i < 150; i++) { if ((await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const putBytes = (path, buf) => ev(`disk[${JSON.stringify(path)}] = new Uint8Array(${JSON.stringify([...buf])})`);
  await putBytes('home/skills.json', readFileSync(join(disk, 'home/skills.json')));
  for (const n of names) await putBytes(`home/${manifest.skills[n].policy}`, readFileSync(join(disk, 'home', manifest.skills[n].policy)));
  const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } return null; };
  const robotFor = (skill) => { const r = applyRobotTool(initialRobot(defaultDesign(3)), 'do', { skill }, { skills: Object.fromEntries(names.map((n) => [n, {}])) }).state; return r; };
  let edits = 0;
  const lastEvent = {};
  const switchTo = async (skill) => {
    if ((await inner('__walks.skill()')) === skill && lastEvent[skill]) return lastEvent[skill]; // already doing it: no event
    const n = await ev('events.length');
    const robot = { ...robotFor(skill), edits: ++edits }; // a new edit count: the file is a new file every time
    await ev(`disk['creature/robot.json'] = new TextEncoder().encode(${JSON.stringify(serializeRobot(robot))})`);
    const e = await waitEvent('skill-switched', n);
    if (e) lastEvent[skill] = e;
    return e;
  };
  // in-page helpers: pause the loop, step by hand, measure
  await inner(`window.__m = { yaw: (q) => Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6])),
    run(seconds, track) { const a = __walks.app; const n = Math.round(seconds / 0.02); let minUp = 1, last = this.yaw(a.sim.data.qpos), unwrapped = 0, footMax = 0, foot0 = -1;
      const fi = (() => { const m = a.sim.model; for (let i = 0; i < m.ngeom; i++) if (m.geom(i).name === 'l0_foot') return i; return -1; })();
      for (let i = 0; i < n; i++) { a.sim.step(a.policy); const up = a.sim.uprightness(); if (up < minUp) minUp = up; const y = this.yaw(a.sim.data.qpos); let d = y - last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; unwrapped += d; last = y; if (fi >= 0) footMax = Math.max(footMax, a.sim.data.geom_xpos[3 * fi + 2]); }
      return { minUp, yawDelta: unwrapped, upEnd: a.sim.uprightness(), pos: a.sim.torsoPos(), footMax, height: a.sim.data.qpos[2] }; } }`);
  await inner('__walks.app.running = false; 0');
  for (const name of names) {
    const sw = await switchTo(name);
    if (!sw) { out.skills[name] = { error: 'no skill-switched event' }; continue; }
    const r = await inner(`(() => { const a = __walks.app; a.running = false; a.sim.reset(); a.sim.command = ${sw.command}; const p0 = a.sim.torsoPos(), y0 = __m.yaw(a.sim.data.qpos); const r = __m.run(10); const dx = r.pos[0] - p0[0], dy = r.pos[1] - p0[1]; return { ...r, forward: (dx * Math.cos(y0) + dy * Math.sin(y0)) / 10, sideways: (-dx * Math.sin(y0) + dy * Math.cos(y0)) / 10, yawRate: r.yawDelta / 10 }; })()`);
    out.skills[name] = { command: sw.command, forward_mps: +r.forward.toFixed(3), sideways_mps: +r.sideways.toFixed(3), yaw_rad_s: +r.yawRate.toFixed(3), min_upright: +r.minUp.toFixed(2), end_upright: +r.upEnd.toFixed(2), body_height_m: +r.height.toFixed(3), l0_foot_max_z: +r.footMax.toFixed(3) };
    console.log(name.padEnd(11), JSON.stringify(out.skills[name]));
  }
  const pairs = [['walk', 'sprint'], ['sprint', 'walk'], ['walk', 'backwards'], ['backwards', 'walk'], ['walk', 'turn-left'], ['turn-left', 'turn-right'], ['walk', 'spin'], ['spin', 'walk'], ['walk', 'wave'], ['wave', 'walk'], ['walk', 'get-up'], ['sprint', 'backwards']].filter(([a, b]) => names.includes(a) && names.includes(b));
  for (const [from, to] of pairs) {
    const a = await switchTo(from);
    await inner(`(() => { const a = __walks.app; a.running = false; a.sim.reset(); a.sim.command = ${a.command}; __m.run(5); 0; })()`);
    const b = await switchTo(to);
    const r = await inner(`(() => { const a = __walks.app; a.running = false; a.sim.command = ${b.command}; const r = __m.run(5); return r; })()`);
    out.transitions.push({ from, to, fell: r.minUp < 0.3, min_upright: +r.minUp.toFixed(2), end_upright: +r.upEnd.toFixed(2) });
    console.log(`${from} -> ${to}`.padEnd(26), r.minUp < 0.3 ? 'FELL' : 'ok  ', `min ${r.minUp.toFixed(2)} end ${r.upEnd.toFixed(2)}`);
  }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
