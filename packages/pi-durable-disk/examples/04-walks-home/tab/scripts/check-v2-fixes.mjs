// The ordering and state bugs found in review of the v2 page, each as a deterministic scenario in a real page (a parent whose "disk"
// the script writes), asserted, with a non-zero exit code on any failure. CDP_PORT=9333 node scripts/check-v2-fixes.mjs
//   P3D  a 3-DOF walk+getup policy   P2D  a 2-DOF policy (a preset body)   CP  a walk-only 3-DOF policy
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const S = process.env.SHARE ?? '/tmp/pda-demo-d2-tmp/share';
const P3D = process.env.P3D ?? `${S}/policy-3dof-walk-getup.json`, P2D = process.env.P2D ?? `${S}/policy-u0-h100.json`, CP = process.env.CP ?? `${S}/policy-3dof-walk.json`;
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

async function page(fn) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1200, height: 800 });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const Sx = (m, p) => send(m, p, sessionId);
  try {
    await Sx('Page.enable'); await Sx('Runtime.enable');
    await Sx('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await Sx('Page.navigate', { url: `${base}/__harness.html?clean=1&start=default` });
    const ev = async (expr) => { const r = await Sx('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
    let ok = false;
    for (let i = 0; i < 150 && !ok; i++) { ok = (await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready'; if (!ok) await sleep(200); }
    if (!ok) throw new Error('the page did not become ready');
    const arrive = (file, path, kind) => inner(`__walks.onPolicyArrived(${JSON.stringify(readFileSync(file, 'utf8'))}, 'watch', ${JSON.stringify(path)}, ${JSON.stringify(kind)})`);
    const waitSim = async (s) => { const t0 = await inner('__walks.app.sim.time'); for (let i = 0; i < 300 && (await inner('__walks.app.sim.time')) < t0 + s; i++) await sleep(100); };
    await fn({ ev, inner, arrive, waitSim, sleep });
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

// (1) the final policy wins: a checkpoint that arrives after it must not take its place
await page(async ({ inner, arrive, waitSim }) => {
  await arrive(P3D, 'home/policy.json', 'final');
  await waitSim(1);
  const before = await inner('__walks.state()');
  await arrive(CP, 'train/gpu/policy.json', 'checkpoint'); // the later, older file: the training file stays on the disk after the run is home
  await waitSim(1);
  const after = await inner('__walks.state()');
  const label = await inner("document.getElementById('stateLabel').textContent");
  check('1. a late checkpoint does not replace the final policy', after.policy === 'home/policy.json' && after.state === 'trained' && after.final === true && label === 'trained', `policy=${after.policy} state=${after.state} label="${label}" (before: ${before.policy})`);
  check('1. the creature still has the final policy\'s getup network', await inner('__walks.app.policy?.hasGetup === true'));
});

// (4) a removed policy leaves no stale status: a new body, the stand-only button, the dummy
await page(async ({ inner, arrive, waitSim }) => {
  await arrive(P3D, 'home/policy.json', 'final');
  await waitSim(1);
  const s0 = await inner('__walks.state()');
  check('4. precondition: trained, final, with facts', s0.state === 'trained' && s0.final && s0.checkpoint_n >= 1 && s0.steps !== null, JSON.stringify({ state: s0.state, n: s0.checkpoint_n, steps: s0.steps }));
  await inner("[...document.querySelectorAll('#presets button')].find((b) => b.textContent === 'long legs').click()");
  await waitSim(1.5);
  const s1 = await inner('__walks.state()');
  const label1 = await inner("document.getElementById('stateLabel').textContent");
  check('4. a new body clears the training facts and the label', s1.state === 'untrained' && s1.final === false && s1.checkpoint_n === 0 && s1.steps === null && s1.wall_s === null && s1.reported_walk_10s_m === null && label1 === 'untrained: random moves', JSON.stringify({ state: s1.state, final: s1.final, n: s1.checkpoint_n, steps: s1.steps, label: label1 }));
});

// (4b) the stand-only button on a body that has a live checkpoint: the checkpoint file differs from the final's bytes, so it installs (the
// 8 s dedupe drops a repeat of the same bytes) and the creature really is in the learning state before the button is pressed
await page(async ({ inner, arrive, waitSim }) => {
  await arrive(CP, 'train/gpu/policy.json', 'checkpoint');
  await waitSim(1);
  const s1 = await inner('__walks.state()');
  const label1 = await inner("document.getElementById('stateLabel').textContent");
  check('4. precondition: the checkpoint installed, so the creature is learning', s1.state === 'learning' && s1.checkpoint_n === 1 && s1.steps !== null && /^learning: version 1/.test(label1), JSON.stringify({ state: s1.state, n: s1.checkpoint_n, steps: s1.steps, label: label1 }));
  await inner("document.getElementById('noPolicy').click()");
  const s2 = await inner('__walks.state()');
  const label2 = await inner("document.getElementById('stateLabel').textContent");
  check('4. the stand-only button does not leave the "learning" label or its facts', s2.state === 'dummy' && s2.checkpoint_n === 0 && s2.steps === null && s2.wall_s === null && s2.reported_walk_10s_m === null && !/^(learning|trained)/.test(label2) && /stand only/.test(label2), JSON.stringify({ state: s2.state, n: s2.checkpoint_n, label: label2 }));
});

// (7) the run comes home with the same bytes as its last checkpoint, within the dedupe window: the final file is still the final
await page(async ({ inner, arrive, waitSim }) => {
  await arrive(P3D, 'train/gpu/policy.json', 'checkpoint');
  await waitSim(1);
  const s0 = await inner('__walks.state()');
  check('7. precondition: learning on the checkpoint', s0.state === 'learning' && s0.final === false, JSON.stringify({ state: s0.state, final: s0.final }));
  await arrive(P3D, 'home/policy.json', 'final'); // the very same bytes, a second later
  await waitSim(1);
  const s1 = await inner('__walks.state()');
  const label = await inner("document.getElementById('stateLabel').textContent");
  const sub = await inner("getComputedStyle(document.getElementById('stateSub')).display");
  check('7. the identical file arriving as the final one makes the creature trained, with the learning line gone', s1.state === 'trained' && s1.final === true && label === 'trained' && sub === 'none', JSON.stringify({ state: s1.state, final: s1.final, label, sub }));
});

// (6) a walk report never spans a body change
await page(async ({ ev, inner, arrive, waitSim }) => {
  await ev('storageDelayMs = 700'); // a slow disk: the page keeps running frames while the body switch waits for its saves
  const n0 = await ev('events.length');
  const t1 = await inner('__walks.app.sim.time'); // the install is the first thing the arrival does: the measurement starts here (its later saves are slow, and the creature walks through them)
  await arrive(P3D, 'train/gpu/policy.json', 'checkpoint');
  await waitSim(2);
  const t2 = await inner('__walks.app.sim.time');
  await arrive(P2D, 'home/policy.json', 'final'); // names the 2-DOF preset: the page switches body, then installs
  await waitSim(1);
  const walked = await ev(`events.slice(${n0}).filter(e => e.type === 'policy-walked')`);
  const first = walked[0];
  check('6. the measurement cut by a body change is reported once, with a sane window', !!first && first.partial === true && first.window_seconds >= t2 - t1 - 0.3 && first.window_seconds <= t2 - t1 + 0.5, JSON.stringify(first && { partial: first.partial, window_seconds: first.window_seconds, simulated_between_installs: +(t2 - t1).toFixed(2), mean_speed: first.mean_speed }));
  // the creature walked at about 0.5 m/s (command 0.5) the whole time it ran; a speed far from that is a distance taken across two bodies
  check('6. its speed is what the creature really walked, not a distance across two bodies', !!first && first.mean_speed > 0.35 && first.mean_speed < 0.7, `mean_speed=${first && first.mean_speed}`);
  check('6. every walked report has a non-negative window', walked.every((w) => w.window_seconds >= 0), walked.map((w) => w.window_seconds).join(', '));
});

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
ws.close(); server.close();
process.exit(failures.length ? 1 : 0);
