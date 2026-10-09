// The real page with a given body and the trainer's policy for it: does it load, walk, and get up after a hard kick?
//   DESIGN=<design.json> POLICY=<policy.json> CDP_PORT=9333 node scripts/check-body.mjs
import { readFileSync } from 'node:fs';
import { openApp, sleep } from './_cdp.mjs';

const design = JSON.parse(readFileSync(process.env.DESIGN, 'utf8'));
const policy = readFileSync(process.env.POLICY, 'utf8');
const app = await openApp({ width: Number(process.env.W ?? 700), height: Number(process.env.H ?? 500), throttle: Number(process.env.THROTTLE ?? 1) });
const { ev } = app;
const waitSim = async (s) => { const t0 = await ev('__walks.app.sim.time'); for (let i = 0; i < 600 && (await ev('__walks.app.sim.time')) < t0 + s; i++) await sleep(100); };
const out = { body: design.name, joints: null };
await ev(`__walks.app.sketcher.set(${JSON.stringify(design)})`);
await ev(`__walks.buildCreature(${JSON.stringify(design)}, false)`);
out.joints = await ev('__walks.app.built.jointNames.length');
out.load = await ev(`__walks.loadPolicyText(${JSON.stringify(policy)}, 'policy.json').then(() => 'loaded', (e) => 'REFUSED: ' + e.message)`);
out.error = await ev("document.getElementById('err').textContent");
if (out.load === 'loaded') {
  for (const command of [0.5, 0.8]) {
    await ev(`document.getElementById('command').value = ${command}; document.getElementById('command').dispatchEvent(new Event('input'))`);
    await waitSim(1.5);
    const a = await ev('({x: __walks.app.sim.data.qpos[0], y: __walks.app.sim.data.qpos[1], t: __walks.app.sim.time, q: Array.from(__walks.app.sim.data.qpos.slice(3, 7))})');
    await waitSim(10);
    const b = await ev('({x: __walks.app.sim.data.qpos[0], y: __walks.app.sim.data.qpos[1], t: __walks.app.sim.time, up: __walks.app.sim.uprightness()})');
    const yaw = Math.atan2(2 * (a.q[0] * a.q[3] + a.q[1] * a.q[2]), 1 - 2 * (a.q[2] * a.q[2] + a.q[3] * a.q[3]));
    const dt = b.t - a.t;
    out[`walk_at_${command}`] = { m_per_s_along_heading: +((((b.x - a.x) * Math.cos(yaw) + (b.y - a.y) * Math.sin(yaw))) / dt).toFixed(3), m_per_s_total: +(Math.hypot(b.x - a.x, b.y - a.y) / dt).toFixed(3), upright: +b.up.toFixed(2) };
  }
  await ev('document.getElementById("command").value = 0.5; document.getElementById("command").dispatchEvent(new Event("input"))');
  await ev('__walks.resetSim()'); await waitSim(2);
  const before = JSON.parse(await ev('JSON.stringify(__walks.stats())'));
  await ev('__walks.kickWorld(0, 1, 400)');
  let minUp = 1, seen = new Set(), back = null; const t0 = await ev('__walks.app.sim.time');
  for (let i = 0; i < 300; i++) { const o = JSON.parse(await ev('JSON.stringify({m: __walks.app.sim.mode, up: __walks.app.sim.uprightness(), t: __walks.app.sim.time})')); minUp = Math.min(minUp, o.up); seen.add(o.m); if (seen.has('getup') && o.m === 'walk' && o.up > 0.9 && back === null) back = o.t - t0; if (o.t - t0 > 10) break; await sleep(100); }
  out.kick_400N = { went_down: minUp < 0.3, getup_network_engaged: seen.has('getup'), up_again: back !== null, sim_s_until_walking_again: back === null ? null : +back.toFixed(2), final_upright: +(await ev('__walks.app.sim.uprightness()')).toFixed(2) };
}
out.nan = (await ev('__walks.stats().nan'));
console.log(JSON.stringify(out));
await app.close();
