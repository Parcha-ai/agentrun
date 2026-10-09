// The v2 take in the real page, end to end, with the page embedded in a parent whose "disk" the script writes:
// untrained start (flops), live checkpoints (walk-only first, then one with a getup net), the final file, then the network off.
//   CDP_PORT=9333 CP1=<walk-only 3-DOF policy> CP2=<3-DOF walk+getup policy> FINAL=<final policy> node scripts/check-v2.mjs <outdir>
// All three policies must be for the default 3-DOF body.
import WebSocket from 'ws';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { outDir } from './outdir.mjs';

const out = outDir(process.argv[2]);
mkdirSync(out, { recursive: true });
const { CP1, CP2, FINAL } = process.env;
if (!CP1 || !CP2 || !FINAL) throw new Error('set CP1, CP2 and FINAL');
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = Number(process.env.W ?? 1400), H = Number(process.env.H ?? 800);

const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: W, height: H });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const R = {};
try {
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: `${base}/__harness.html?clean=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
  const shot = async (name) => writeFileSync(`${out}/${name}.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const put = (path, file) => ev(`disk[${JSON.stringify(path)}] = new TextEncoder().encode(${JSON.stringify(readFileSync(file, 'utf8'))})`);
  const waitFor = async (expr, ms = 30000) => { for (let t = 0; t < ms; t += 200) { if (await inner(expr).catch(() => false)) return true; await sleep(200); } return false; };
  const waitSim = async (s) => { const t0 = await inner('__walks.app.sim.time'); for (let i = 0; i < 400 && (await inner('__walks.app.sim.time')) < t0 + s; i++) await sleep(100); };
  const evs = (type) => ev(`events.filter(e => e.type === ${JSON.stringify(type)})`);

  for (let i = 0; i < 150 && (await inner("document.getElementById('status')?.textContent").catch(() => null)) !== 'ready'; i++) await sleep(200);
  // ---- 1. the untrained start
  const label = () => inner("(() => { const l = document.getElementById('stateLabel'); return { text: l.textContent, state: l.dataset.state }; })()");
  R.start = {
    state: await inner('__walks.state()'), label: await label(),
    headerHidden: await inner("getComputedStyle(document.querySelector('header')).display === 'none'"),
    hudHidden: await inner("getComputedStyle(document.getElementById('hud')).display === 'none'"),
    toolbarHidden: await inner("getComputedStyle(document.getElementById('toolbar')).display === 'none'"),
    sketcherVisible: await inner("document.getElementById('sketch').getBoundingClientRect().width > 100"),
    creatureFillsRest: await inner("(() => { const r = document.getElementById('view').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()"),
    untrainedEvent: (await evs('untrained')).length,
    creatureFilesOnDiskBeforeAnyDrawing: await ev("Object.keys(disk).filter((k) => k.startsWith('creature/c') || k.startsWith('creature/b'))"),
  };
  await sleep(300); await shot('v2-1-draw');
  R.start.flopped = await waitFor('__walks.app.sim.uprightness() < 0.3', 20000);
  R.start.simTimeWhenDown = await inner('+__walks.app.sim.time.toFixed(2)');
  await sleep(1500); await shot('v2-2-flopped');
  // ---- 2. commit the drawing (the default body here): the files land
  await inner('__walks.commitDesign()');
  R.commit = { files: await ev("Object.keys(disk).filter((k) => k.startsWith('creature/c') || k.startsWith('creature/b'))") };
  // ---- 3. checkpoint 1: walk-only, creature lying
  const n0 = await ev('events.length');
  await put('train/gpu/policy.json', CP1);
  R.cp1Installed = await waitFor("__walks.state().state === 'learning'", 20000);
  R.cp1 = { label: await label(), state: await inner('__walks.state()'), arrived: (await ev(`events.slice(${n0}).filter(e => e.type === 'policy-arrived')`))[0], stoodUp: (await ev(`events.slice(${n0}).filter(e => e.type === 'stood-up')`)).length };
  await waitSim(3); await shot('v2-3-checkpoint1');
  R.cp1.upright3sLater = await inner('+__walks.app.sim.uprightness().toFixed(2)');
  R.cp1.phaseAfterFirstCheckpoint = await inner('__walks.state().phase');
  R.cp1.sketcherHiddenNow = await inner("getComputedStyle(document.querySelector('aside')).display === 'none'");
  // ---- 4. checkpoint 2: with a getup net
  const n1 = await ev('events.length');
  await put('train/gpu/policy.json', CP2);
  await waitFor("__walks.state().checkpoint_n === 2", 20000);
  R.cp2 = { label: await label(), arrived: (await ev(`events.slice(${n1}).filter(e => e.type === 'policy-arrived')`))[0], walkedPartial: (await ev(`events.slice(${n1}).filter(e => e.type === 'policy-walked')`))[0], stoodUp: (await ev(`events.slice(${n1}).filter(e => e.type === 'stood-up')`)).length };
  await waitSim(2);
  // ---- 5. the final file
  const n2 = await ev('events.length');
  await put('home/policy.json', FINAL);
  await waitFor('__walks.state().final === true', 20000);
  R.final = { label: await label(), state: await inner('__walks.state()'), arrived: (await ev(`events.slice(${n2}).filter(e => e.type === 'policy-arrived')`))[0] };
  await waitSim(11);
  R.final.walked = (await ev(`events.filter(e => e.type === 'policy-walked').slice(-1)`))[0];
  await shot('v2-4-trained');
  // ---- 6. the network off
  const before = await inner('({ t: __walks.app.sim.time, x: __walks.app.sim.torsoPos()[0], y: __walks.app.sim.torsoPos()[1] })');
  const errsBefore = await inner('__walks.stats().nan + __walks.stats().resetsSeen');
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  R.offline = { badge: await inner("!document.getElementById('offlineBadge').hidden"), stateOffline: (await inner('__walks.state()')).offline, networkEvent: (await ev("events.filter(e => e.type === 'network').slice(-1)"))[0] };
  await waitSim(6);
  const mid = await inner('({ t: __walks.app.sim.time, x: __walks.app.sim.torsoPos()[0], y: __walks.app.sim.torsoPos()[1] })');
  R.offline.walkedWhileOffline = { sim_seconds: +(mid.t - before.t).toFixed(2), metres: +Math.hypot(mid.x - before.x, mid.y - before.y).toFixed(2) };
  await shot('v2-5-offline');
  // A kick that does not topple the creature shows nothing about getting up: push harder, up to four times, and say how many it took.
  const k0 = await inner('__walks.stats().getups');
  R.offline.kick = { attempts: [], getupEngaged: false, upAgain: false };
  for (const force of [350, 450, 550, 650]) {
    await inner(`__walks.kick([1, 0], ${force})`);
    const engaged = await waitFor('__walks.stats().getups > ' + k0, 6000);
    R.offline.kick.attempts.push({ force_n: force, toppled: engaged });
    if (engaged) break;
    await waitSim(1.5);
  }
  await waitFor("__walks.app.sim.mode === 'walk' && __walks.app.sim.uprightness() > 0.9", 15000);
  R.offline.kick.getupEngaged = (await inner('__walks.stats().getups')) > k0;
  R.offline.kick.upAgain = await inner('__walks.app.sim.uprightness() > 0.9');
  await waitSim(2);
  R.offline.nanOrResetsDuringOffline = (await inner('__walks.stats().nan + __walks.stats().resetsSeen')) - errsBefore;
  R.offline.stillWalking = await inner('Math.hypot(__walks.app.sim.data.qvel[0], __walks.app.sim.data.qvel[1]) > 0.2');
  await S('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  R.offline.badgeAfterBackOnline = await inner("!document.getElementById('offlineBadge').hidden");
  R.events = (await ev('events.map(e => e.type)')).reduce((a, t) => ((a[t] = (a[t] ?? 0) + 1), a), {});
  console.log(JSON.stringify(R, null, 1));
  // Every step above has to have really happened: a step that did not is a FAIL and a nonzero exit, never a quiet null.
  const checks = [
    ['the creature starts untrained, on screen, before any file', R.start.state.state === 'untrained' && R.start.label.state === 'untrained' && R.start.label.text === 'untrained: random moves' && R.start.untrainedEvent >= 1 && R.start.creatureFilesOnDiskBeforeAnyDrawing.length === 0],
    ['clean mode hides the header, HUD and toolbar and shows the sketcher', R.start.headerHidden && R.start.hudHidden && R.start.toolbarHidden && R.start.sketcherVisible],
    ['the untrained creature flops (uprightness under 0.3)', R.start.flopped === true],
    ['committing the drawing writes the creature files', R.commit.files.length >= 2],
    ['checkpoint 1 installs: state learning, label, policy-arrived (checkpoint)', R.cp1Installed === true && R.cp1.state.state === 'learning' && /version 1/.test(R.cp1.label.text) && R.cp1.arrived?.kind === 'checkpoint'],
    ['checkpoint 1 stands the lying creature up (stood-up event, upright 3 s later)', R.cp1.stoodUp >= 1 && Number(R.cp1.upright3sLater) > 0.8],
    ['the sketcher is hidden once the first checkpoint arrives', R.cp1.sketcherHiddenNow === true],
    ['checkpoint 2 swaps live: label says version 2, the cut measurement is reported partial', /version 2/.test(R.cp2.label.text) && R.cp2.arrived?.kind === 'checkpoint' && R.cp2.walkedPartial?.partial === true],
    ['the final file replaces the checkpoint: state trained, final', R.final.state.state === 'trained' && R.final.state.final === true && R.final.arrived?.kind === 'final'],
    ['the final policy walks a full measurement window', R.final.walked && R.final.walked.partial !== true && R.final.walked.mean_speed > 0.2],
    ['offline: the badge shows and the network event fires', R.offline.badge === true && R.offline.stateOffline === true && R.offline.networkEvent?.online === false],
    ['offline: the creature keeps walking (more than 1 m, still moving)', R.offline.walkedWhileOffline.metres > 1 && R.offline.stillWalking === true],
    ['offline: a kick is recovered by the getup network and no NaN or reset', R.offline.kick.getupEngaged === true && R.offline.kick.upAgain === true && R.offline.nanOrResetsDuringOffline === 0],
    ['back online: the badge clears', R.offline.badgeAfterBackOnline === false],
  ];
  let failed = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; }
  console.log(failed ? `${failed} of ${checks.length} checks FAILED` : 'all checks passed');
  if (failed) process.exitCode = 1;
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
