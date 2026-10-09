// Frame rate and physics cost of the page under CPU throttling, for the live-demo shoot.
//   CDP_PORT=9333 THROTTLE=4 W=700 H=500 PHASE_S=15 [POLICY=policy.json] node scripts/perf.mjs
// Phases: the dummy trot on the 3-DOF body ("walking"); a synthetic two-net policy with the creature held on its side so the
// getup network is the one running ("getup"); and, with POLICY, a trained policy ("policy"). Prints one JSON table:
// render fps, control steps per second (50 = real time), the real-time factor of the simulation (simulated s per wall s),
// frame interval p50/p95/max, the time spent in physics and in draw per frame, and the JS heap after a forced GC.
import { readFileSync } from 'node:fs';
import { openApp, sleep, syntheticTwoNetPolicy } from './_cdp.mjs';

const throttle = Number(process.env.THROTTLE ?? 4);
const width = Number(process.env.W ?? 700), height = Number(process.env.H ?? 500);
const phaseS = Number(process.env.PHASE_S ?? 15);
const app = await openApp({ throttle, width, height, query: process.env.LITE ? '?lite=1' : '' });
const { ev } = app;
// STALL_MS=150: block the page's main thread for that long every 2 s, as a busy machine or a GC does, to see whether the simulation drifts behind real time
if (process.env.STALL_MS) await ev(`setInterval(() => { const t = performance.now(); while (performance.now() - t < ${Number(process.env.STALL_MS)}); }, 2000)`);

async function measure(label, setup) {
  if (setup) await setup();
  await sleep(3000); // warm-up: JIT, shader compile, the first frames
  const a = JSON.parse(await ev('JSON.stringify(__walks.stats())')), t0 = await ev('performance.now()'), s0 = await ev('__walks.app.sim.time');
  const m0 = await ev('__walks.app.sim.mode');
  await sleep(phaseS * 1000);
  const b = JSON.parse(await ev('JSON.stringify(__walks.stats())')), t1 = await ev('performance.now()'), s1 = await ev('__walks.app.sim.time');
  const wall = (t1 - t0) / 1000;
  return {
    phase: label, wall_s: +wall.toFixed(1), mode_at_start: m0, mode_at_end: await ev('__walks.app.sim.mode'),
    render_fps: +((b.frames - a.frames) / wall).toFixed(1),
    control_steps_per_s: +((b.steps - a.steps) / wall).toFixed(1), // 50 = the simulation keeps up with the wall clock
    realtime_factor: +((s1 - s0) / wall).toFixed(3),
    frame_interval_ms: b.frameMs, physics_ms_per_frame: b.stepMs, draw_ms_per_frame: b.drawMs,
    heap_mb: await app.heapMB(),
    nan: b.nan - a.nan, unexpected_resets: b.resetsSeen - a.resetsSeen,
  };
}

const rows = [];
rows.push(await measure('walking (dummy trot, 3-DOF)'));
const two = await syntheticTwoNetPolicy(ev);
rows.push(await measure('getup network running (synthetic two-net, creature on its side)', async () => {
  await ev(`__walks.loadPolicyText(${JSON.stringify(two)}, 'synthetic-two-net')`);
  // keep it down: re-roll onto its side every 200 ms so the getup net stays the one that drives it
  await ev(`window.__hold = setInterval(() => { const q = __walks.app.sim.data.qpos; q[3] = Math.SQRT1_2; q[4] = Math.SQRT1_2; q[5] = 0; q[6] = 0; }, 200)`);
}));
await ev('clearInterval(window.__hold)');
if (process.env.POLICY) {
  rows.push(await measure('trained policy walking', async () => {
    await ev(`__walks.loadPolicyText(${JSON.stringify(readFileSync(process.env.POLICY, 'utf8'))}, 'policy.json')`);
    await ev('__walks.resetSim()');
  }));
}
console.log(JSON.stringify({ throttle, viewport: `${width}x${height}`, body: await ev('__walks.app.built.jointNames.length + " joints"'), rows }, null, 1));
await app.close();
