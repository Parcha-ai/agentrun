// The tab app: sketch -> MJCF -> MuJoCo (WASM) -> render, a policy that runs offline, kicks, and the memory view.
// Embedded by the show page as a same-origin iframe; see POLICY-FORMAT.md and the "walks-home" message protocol below.

import { defaultDesign, PRESETS, validateDesign, type Design } from './design.ts';
import { buildMjcf, type Built, type World } from './mjcf.ts';
import { Policy, PolicyRefused, sha256Hex } from './policy.ts';
import { dummyPolicy } from './dummy.ts';
import { presetForSha } from './bodies.ts';
import { bodyNotes } from './rules.ts';
import { Stats } from './stats.ts';
import { ArrivalDedupe, ArrivalTracker, describeArrival, HOME_POLICY_PATH, PolicyWatcher, planArrival, type ArrivalResult } from './arrival.ts';
import { Sim } from './sim.ts';
import { View } from './render.ts';
import { Sketcher } from './sketch.ts';
import { CreatureStore, type Backend, type Backends, type MachineEvent } from './store.ts';
import { CONTROL_DT } from './mjcf.ts';
import { ParentBackend, windowBus, DESIGNS_PATH, MEMORY_PATH, NotHolder, parentPolicySource } from './backend.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- message protocol with the show page (all messages carry ns: "walks-home") ----------------------------
// tab -> parent: ready, design-saved, policy-loaded, kicked, fell, stood, memory-opened
// parent -> tab: set-placement {kind, label, since}, kick {dir, force_n}, open-memory, load-policy {url}, load-design {design}
const NS = 'walks-home';
const post = (type: string, body: Record<string, unknown> = {}) => {
  if (window.parent !== window) window.parent.postMessage({ ns: NS, type, ...body }, location.origin);
};

// ---- storage: IndexedDB holds the SQLite bytes when the app runs on its own ------------------------------
class IdbBackend implements Backend {
  private db: Promise<IDBDatabase>;
  private key: string;
  constructor(key: string) {
    this.key = key;
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open('walks-home-creature', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((res, rej) => {
      const r = fn(db.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async read() { return (await this.tx('readonly', (s) => s.get(this.key))) ?? null; }
  async write(b: Uint8Array) { await this.tx('readwrite', (s) => s.put(b, this.key)); }
}

interface App {
  mj: any; sql: any; mujocoVersion: string;
  view: View; sketcher: Sketcher; store: CreatureStore; storageMode: 'disk' | 'browser';
  sim: Sim; built: Built; bodySha: string; world: World | null;
  policy: Policy | null; policyName: string;
  running: boolean; acc: number; last: number;
  fallen: boolean; recovering: number | null; // sim time at which a kick was applied and not yet recovered
  placement: { kind: string; label: string };
  /** A trained policy that arrived and is being timed: page ms at the arrival, sim time at the install. */
  arrival: { tracker: ArrivalTracker; simT0: number; name: string } | null;
  lastArrival: ArrivalResult | null;
  /** The network mode last announced; see Sim.mode. */
  lastMode: 'walk' | 'getup';
  stats: Stats;
  /** Set when the page itself restarts the sim clock, so the stats do not count it as an unexpected reset. */
  expectReset: boolean;
}

const MAX_DRAG_KICK_N = 100;
const MAX_CATCHUP_S = 0.5;
const MAX_STEPS_PER_FRAME = Math.round(MAX_CATCHUP_S / CONTROL_DT);

const arrivalDedupe = new ArrivalDedupe();

let app: App;

function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 1600);
}

function showError(text: string) { $('err').textContent = text; }

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => res();
    el.onerror = () => rej(new Error(`could not load ${src}`));
    document.head.append(el);
  });
}

// sql.js is a UMD script (it defines window.initSqlJs); MuJoCo is an ES module. Both are served from ./vendor/.
async function loadVendor() {
  const base = new URL('./vendor/', import.meta.url).href;
  await loadScript(base + 'sql-wasm.js');
  const [{ default: loadMuJoCo }, versions] = await Promise.all([
    import(/* @vite-ignore */ base + 'mujoco.js'), fetch(new URL('./versions.json', import.meta.url)).then((r) => r.json()),
  ]);
  const [mj, sql] = await Promise.all([loadMuJoCo(), (window as any).initSqlJs({ locateFile: (f: string) => base + f })]);
  return { mj, sql, mujocoVersion: versions.mujoco as string };
}

/** The body as the trainer and the forks need it: creature.xml byte for byte, and body.json (joint order, stand pose).
 *  Written next to the SQLite files, only when there is a disk behind the page and this tab may write. */
async function publishBody() {
  if (app.storageMode !== 'disk') return;
  const { xml, legs, jointsPerLeg, jointNames, standPose, standHeight } = app.world ? { ...buildMjcf(app.sketcher.get()) } : app.built;
  const enc = new TextEncoder();
  await new ParentBackend(windowBus(), 'creature/creature.xml').write(enc.encode(xml));
  await new ParentBackend(windowBus(), 'creature/body.json').write(enc.encode(JSON.stringify({ legs, jointsPerLeg, jointNames, standPose, standHeight, mjcf_sha256: app.bodySha }, null, 1) + '\n'));
}

/** Save the body to designs.sqlite; when another machine holds the run, ask the agent to save it instead. */
async function saveDesign(design: Design) {
  try {
    const saved = await app.store.saveDesign(design);
    await publishBody();
    post('design-saved', { id: saved.id, name: design.name, sha256: saved.sha256, mjcf_sha256: app.bodySha });
  } catch (e) {
    if (!(e instanceof NotHolder)) throw e;
    post('design-request', { design, mjcf_sha256: app.bodySha });
    showError('The agent moved to another machine: this design is only in this tab, and the request to save it was sent to the agent.');
  }
}

async function buildCreature(design: Design, keepPolicy: boolean) {
  const errs = validateDesign(design);
  if (errs.length) { showError(errs.join('\n')); return; }
  showError('');
  const built = buildMjcf(design, app.world ?? undefined);
  // The body's identity (what a policy is checked against) never includes the terrain.
  app.bodySha = await sha256Hex(app.world ? buildMjcf(design).xml : built.xml);
  // A policy belongs to one body (mjcf_sha256). Take it off BEFORE the new simulation exists and before any await: the page
  // keeps stepping while saves and loads are pending, and a policy with another joint count would otherwise drive the new
  // body with an observation read past its arrays (NaN, and a creature that never recovers).
  const droppedPolicy = !!app.policy && app.policy.file.mjcf_sha256 !== app.bodySha;
  if (droppedPolicy) setPolicy(null, app.policyName === 'dummy trot' ? 'dummy trot' : 'none');
  app.built = built;
  app.sim = new Sim(app.mj, built);
  app.view.setSim(app.sim);
  app.fallen = false; app.recovering = null; app.lastMode = 'walk'; app.expectReset = true;
  await saveDesign(design);
  // The dummy is generated from the body, so it is rebuilt for the new one.
  if (app.policyName === 'dummy trot') {
    await useDummy();
  } else if (keepPolicy && droppedPolicy) {
    showError('The loaded policy was trained for another body, so it was removed. Load one for this body.');
  }
  applyCommand();
  renderPairs();
}

/** The slider is the single source of the command: apply it to the sim (a new Sim starts at 0, which a policy reads as "stand"). */
function applyCommand() {
  const input = $('command') as HTMLInputElement;
  // A policy trained for a command range limits the slider to it.
  const range = (app.policy?.file as { command_range?: [number, number] } | undefined)?.command_range;
  input.min = String(range?.[0] ?? 0);
  input.max = String(range?.[1] ?? 1);
  const v = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value)));
  input.value = String(v);
  app.sim.command = v;
  $('commandOut').textContent = v.toFixed(2);
}

function setPolicy(p: Policy | null, name: string) {
  app.policy = p;
  app.policyName = name;
  $('policyName').textContent = name;
  applyCommand();
}

async function useDummy() {
  const file = dummyPolicy({ mjcfSha256: app.bodySha, mujocoVersion: app.mujocoVersion, nj: app.built.jointNames.length, jointsPerLeg: app.built.jointsPerLeg });
  setPolicy(await Policy.load(file, { mjcfSha256: app.bodySha, nj: app.built.jointNames.length, mujocoVersion: app.mujocoVersion }), 'dummy trot');
  post('policy-loaded', { name: 'dummy trot', mjcf_sha256: app.bodySha, bytes: JSON.stringify(file).length });
}

async function loadPolicyText(text: string, name: string) {
  try {
    // A policy names its body. If that is another preset (say the first 2-DOF body), switch to it rather than refuse.
    let wanted: string | undefined;
    try { wanted = JSON.parse(text).mjcf_sha256; } catch { /* not JSON: Policy.load reports it */ }
    if (wanted && wanted !== app.bodySha) {
      const preset = await presetForSha(wanted);
      if (preset) {
        app.sketcher.set(preset.design);
        await buildCreature(structuredClone(preset.design), false);
        toast(`body switched to "${preset.name}" to match the policy`);
      }
    }
    const p = await Policy.load(text, { mjcfSha256: app.bodySha, nj: app.built.jointNames.length, mujocoVersion: app.mujocoVersion });
    setPolicy(p, name);
    app.sim.reset();
    app.expectReset = true;
    app.fallen = false; app.recovering = null; app.lastMode = 'walk';
    showError('');
    post('policy-loaded', { name, mjcf_sha256: p.file.mjcf_sha256, bytes: text.length });
    toast(`policy loaded: ${name}`);
  } catch (e) {
    const reason = e instanceof PolicyRefused ? e.message : e instanceof SyntaxError ? 'the file is not valid JSON' : String(e);
    showError(`Policy refused: ${reason}`);
    post('policy-refused', { name, reason });
    throw e;
  }
}

/**
 * A trained policy has landed (the watcher saw work/home/policy.json, or the shell said the run is home). Validate it
 * against the body, switch body if it names another preset, hot-swap it into the running creature (no reset), say where
 * it came from using only what the file records, and time how long the creature takes to walk with it.
 */
async function onPolicyArrived(text: string, via: 'watch' | 'message', name = 'policy.json') {
  const arrivedAt = performance.now();
  // the same file announced twice (the stage's load-policy and the watcher) is one arrival
  if (!arrivalDedupe.accept(await sha256Hex(text), arrivedAt)) return;
  const refuse = (reason: string) => {
    showError(`Policy refused: ${reason}`);
    post('policy-refused', { name, reason, via });
  };
  const plan = await planArrival(text, app.bodySha, presetForSha);
  if (plan.action === 'refuse') return refuse(plan.reason);
  if (plan.action === 'switch-body') {
    app.sketcher.set(plan.preset.design);
    await buildCreature(structuredClone(plan.preset.design), false);
  }
  let policy: Policy;
  try {
    policy = await Policy.load(text, { mjcfSha256: app.bodySha, nj: app.built.jointNames.length, mujocoVersion: app.mujocoVersion });
  } catch (e) {
    return refuse(e instanceof PolicyRefused ? e.message : String(e));
  }
  showError('');
  setPolicy(policy, name); // no sim.reset(): the creature that was standing starts walking
  app.fallen = false; app.recovering = null;
  const installedAt = performance.now();
  const meta = plan.meta;
  const message = describeArrival(meta);
  toast(message);
  app.arrival = { tracker: new ArrivalTracker({ arrivedAtMs: arrivedAt, installedAtMs: installedAt, command: app.sim.command }), simT0: app.sim.time, name };
  app.lastArrival = null;
  post('policy-arrived', {
    name, via, message, host: meta.host, training_seconds: meta.trainingSeconds, mjcf_sha256: policy.file.mjcf_sha256,
    switched_body: plan.action === 'switch-body' ? plan.preset.name : null, arrival_to_installed_ms: Math.round(installedAt - arrivedAt), bytes: text.length,
  });
}

/** Fetch a policy file and load it; a missing file (the run is not home yet) is a refusal, not a broken tab. */
async function loadPolicyUrl(url: string) {
  const name = (url.split('/').pop() ?? 'policy').slice(0, 80); // a data: or long URL must not flood the HUD
  let text: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    const reason = `could not fetch ${url}: ${e instanceof Error ? e.message : e}`;
    showError(`Policy refused: ${reason}`);
    post('policy-refused', { name, reason });
    return;
  }
  await onPolicyArrived(text, 'message', name); // refusals are reported inside
}

function yawDir(x: number, y: number): [number, number] {
  const q = app.sim.data.qpos;
  const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  return [x * Math.cos(yaw) - y * Math.sin(yaw), x * Math.sin(yaw) + y * Math.cos(yaw)];
}

function kickWorld(wx: number, wy: number, force: number) {
  app.stats.c.kicks++;
  const n = Math.hypot(wx, wy) || 1;
  app.sim.kick([(wx / n) * force, (wy / n) * force, 0]);
  app.recovering = app.sim.time;
  post('kicked', { force_n: Math.round(force), t: app.sim.time });
  toast(`kick ${Math.round(force)} N`);
}

function kick(dirX: number, dirY: number, force: number) {
  const [wx, wy] = yawDir(dirX, dirY); // dir is given in the creature's heading frame
  kickWorld(wx, wy, force);
}

/** What the clamp last shortened, shown above the notes until the next edit that does not clamp. */
let clampMessages: string[] = [];

function renderNotes(d: Design) {
  const box = $('bodyNotes');
  const rows = [...clampMessages.map((text) => ({ cls: 'clamp', text })), ...bodyNotes(d).map((n) => ({ cls: n.level, text: n.text }))];
  box.replaceChildren(...rows.map((r) => { const el = document.createElement('div'); el.className = r.cls; el.textContent = r.text; return el; }));
}

function renderPairs() {
  const el = $('pairs');
  const d = app.sketcher.get();
  renderNotes(d);
  $('count').textContent = `${d.legs.length * 2} legs`;
  ($('legDof') as HTMLInputElement).checked = d.legDof === 3;
  el.replaceChildren(...d.legs.map((l, i) => {
    const div = document.createElement('div');
    div.className = 'pair';
    div.innerHTML = `<b>Pair ${i + 1}</b>`;
    for (const [k, min, max, step] of [['thigh', 0.08, 0.4, 0.01], ['shin', 0.08, 0.4, 0.01], ['radius', 0.012, 0.04, 0.002]] as const) {
      const lab = document.createElement('span'); lab.textContent = k;
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(l[k]);
      const out = document.createElement('output'); out.textContent = l[k].toFixed(3);
      inp.oninput = () => { app.sketcher.setLeg(i, { [k]: Number(inp.value) }); out.textContent = Number(inp.value).toFixed(3); };
      div.append(lab, inp, out);
    }
    return div;
  }));
}

async function renderMemory() {
  const m = $('memory');
  // Re-read the file: the agent writes machine rows while the tab is idle (every write of ours is already persisted).
  try { app.store = await app.store.reload(app.sql); } catch (e) { showError(`could not re-read memory: ${e}`); }
  const rows = app.store.timeline();
  const designs = app.store.designs();
  const fmt = (e: MachineEvent) => `<li><div class="host">${esc(e.host)}<span class="kind">${esc(e.kind)}</span></div><div class="when">${esc(e.at)}</div><div class="note">${esc(e.note)}</div></li>`;
  m.innerHTML = `<h3>My memory</h3><p>Every machine I have run on, oldest first, and every body I have been given. Both are tables in one SQLite file on my disk.</p>
    <button id="closeMemory">Back to the creature</button>
    ${rows.length ? `<ol class="tl" style="margin-top:20px">${rows.map(fmt).join('')}</ol>` : `<p style="margin-top:20px">Nothing recorded yet.${app.store.memoryWritable ? ' <button id="seedDemo">Add demo rows</button> <span style="font-size:12px">(clearly fake: in a run the agent writes these rows as it moves)</span>' : ' The agent writes a row each time it moves to a machine.'}</p>`}
    <h3 style="margin-top:28px;font-size:14px">Bodies</h3>
    <table class="designs"><tr><th>#</th><th>name</th><th>torso (m)</th><th>legs</th><th>saved</th></tr>
    ${designs.map((d) => `<tr><td>${d.id}</td><td>${esc(d.name)}</td><td>${d.design.torso.length} x ${d.design.torso.width}</td><td>${d.design.legs.length * 2}</td><td>${esc(d.createdAt)}</td></tr>`).join('')}</table>`;
  m.hidden = false;
  $('closeMemory').onclick = () => { m.hidden = true; };
  const seed = document.getElementById('seedDemo');
  if (seed) seed.onclick = async () => {
    const t0 = Date.now();
    const ev = (min: number, host: string, kind: string, note: string) => ({ at: new Date(t0 - (60 - min) * 60000).toISOString(), host, kind, note });
    for (const e of [ev(0, 'tab', 'tab', 'DEMO ROW: sketched the creature'), ev(10, 'daytona:demo-box', 'sandbox', 'DEMO ROW: wrote the training environment'), ev(25, 'gpu:demo-1..8', 'gpu', 'DEMO ROW: trained 8 reward variants'), ev(50, 'tab', 'tab', 'DEMO ROW: back home with the winning policy')]) await app.store.recordMachine(e);
    await renderMemory();
  };
  post('memory-opened', { rows: rows.length });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function hud() {
  const s = app.sim, [x, y, z] = s.torsoPos();
  const v = Math.hypot(s.data.qvel[0], s.data.qvel[1]);
  const r = app.lastArrival;
  const arrivalLine = r ? `\narrival ${r.arrivalToWalkingMs === null ? (r.fell ? 'fell, not walking' : 'not walking yet') : `walking after ${(r.arrivalToWalkingMs / 1000).toFixed(1)} s`}${r.meanSpeed === null ? '' : `, ${r.meanSpeed.toFixed(2)} m/s over ${r.windowSeconds} s`}` : '';
  const modeLine = app.policy?.hasGetup ? `\nmode    ${s.mode === 'getup' ? 'getting up' : 'walking'}` : '';
  $('hud').textContent = `policy  ${app.policyName}\nt       ${s.time.toFixed(1)} s\nspeed   ${v.toFixed(2)} m/s\nheight  ${z.toFixed(2)} m\nupright ${s.uprightness().toFixed(2)}${modeLine}\npos     ${x.toFixed(1)}, ${y.toFixed(1)}${arrivalLine}`;
}

/** The creature went down (the getup net took over) or is back on its feet (walking took over). */
function announceMode() {
  app.lastMode = app.sim.mode;
  if (app.sim.mode === 'getup') app.stats.c.getups++;
  post('mode-changed', { mode: app.sim.mode, t: app.sim.time, up: app.sim.uprightness() });
  toast(app.sim.mode === 'getup' ? 'down: the getup network is driving' : 'back on its feet: walking');
}

function sampleArrival() {
  const a = app.arrival!;
  const [x, y] = app.sim.torsoPos();
  a.tracker.sample(app.sim.time - a.simT0, x, y, app.sim.uprightness(), performance.now());
  const r = a.tracker.result();
  app.lastArrival = r;
  if (r.done) {
    post('policy-walked', {
      name: a.name, arrival_to_installed_ms: Math.round(r.arrivalToInstalledMs),
      arrival_to_walking_ms: r.arrivalToWalkingMs === null ? null : Math.round(r.arrivalToWalkingMs),
      sim_seconds_to_walking: r.simSecondsToWalking, mean_speed: r.meanSpeed, window_seconds: r.windowSeconds, fell: r.fell,
    });
    app.arrival = null;
  }
}

function tick(now: number) {
  requestAnimationFrame(tick);
  // A hitch (GC, a busy machine) is made up by stepping more next frame, up to half a second of simulation, so the creature
  // never falls behind the wall clock; beyond that the backlog is dropped. Physics is cheap (about 1 ms per control step).
  const dt = Math.min((now - app.last) / 1000, MAX_CATCHUP_S);
  app.last = now;
  const t0 = performance.now();
  if (app.running) {
    app.acc += dt;
    let n = 0;
    while (app.acc >= CONTROL_DT && n < MAX_STEPS_PER_FRAME) {
      app.sim.step(app.policy);
      const q = app.sim.data.qpos;
      app.stats.step(app.sim.time, Number.isFinite(q[0] + q[1] + q[2] + q[3] + q[4]), app.expectReset);
      app.expectReset = false;
      if (app.arrival) sampleArrival();
      if (app.sim.mode !== app.lastMode) announceMode();
      app.acc -= CONTROL_DT;
      n++;
    }
    if (n === MAX_STEPS_PER_FRAME) app.acc = 0;
    const up = app.sim.uprightness();
    // `fallen` is true from the moment it goes down until it is upright again, so each fall is counted and announced once
    if (app.fallen && up > 0.9) app.fallen = false;
    if (!app.fallen && up < 0.3) { app.fallen = true; app.stats.c.falls++; post('fell', { t: app.sim.time }); toast('fell'); }
    if (app.recovering !== null && !app.fallen && app.sim.time - app.recovering > 2 && up > 0.9) {
      app.stats.c.recoveries++;
      post('stood', { t: app.sim.time, since_kick: app.sim.time - app.recovering });
      app.recovering = null;
      toast('recovered');
    }
  }
  const t1 = performance.now();
  app.view.draw();
  hud();
  app.stats.frame(now, t1 - t0, performance.now() - t1);
}

async function main() {
  const status = $('status');
  try {
    status.textContent = 'loading MuJoCo';
    const { mj, sql, mujocoVersion } = await loadVendor();
    $('ver').textContent = `MuJoCo ${mujocoVersion}`;
    // On the disk when an embedding page answers storage requests; otherwise this browser only, and the header says so.
    // On the disk the tab writes designs.sqlite only; memory.sqlite is the agent's and the tab just reads it.
    let backends: Backends = { designs: new IdbBackend('designs.sqlite'), memory: new IdbBackend('memory.sqlite') };
    let storageMode: 'disk' | 'browser' = 'browser';
    if (window.parent !== window) {
      const designs = new ParentBackend(windowBus(), DESIGNS_PATH);
      if ((await designs.probe()) !== undefined) { backends = { designs, memory: new ParentBackend(windowBus(), MEMORY_PATH) }; storageMode = 'disk'; }
    }
    let policyBackend: ParentBackend | null = null;
    if (storageMode === 'disk') policyBackend = new ParentBackend(windowBus(), HOME_POLICY_PATH);
    $('storage').textContent = storageMode === 'disk' ? 'memory: creature/*.sqlite on the disk' : 'memory: this browser only (not on the disk)';
    const store = await CreatureStore.open(sql, backends, { memoryWritable: storageMode === 'browser' });
    const design = store.designs()[0]?.design ?? defaultDesign();
    const built = buildMjcf(design);
    const sketcher = new Sketcher($('sketch') as HTMLCanvasElement, design, (d) => { renderPairs(); pendingDesign = d; });
    let pendingDesign: Design | null = null;
    app = {
      mj, sql, mujocoVersion, view: new View($('view') as HTMLCanvasElement, { lite: new URLSearchParams(location.search).has('lite') }), sketcher, store, storageMode,
      sim: new Sim(mj, built), built, bodySha: await sha256Hex(built.xml), world: null,
      policy: null, policyName: 'dummy trot', running: true, acc: 0, last: performance.now(),
      fallen: false, recovering: null, placement: { kind: 'tab', label: 'this tab' }, arrival: null, lastArrival: null, lastMode: 'walk', stats: new Stats(), expectReset: false,
    };
    app.view.setSim(app.sim);
    await useDummy(); // also applies the slider's command to the sim
    await saveDesign(design); // the first body is a body too: the memory view lists it
    renderPairs();
    setPlacement('tab', 'this tab');

    for (const [name, preset] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.textContent = name;
      b.onclick = () => { app.sketcher.set(preset); buildCreature(structuredClone(preset), true).catch((e) => showError(String(e))); };
      $('presets').append(b);
    }
    $('build').onclick = () => buildCreature(app.sketcher.get(), true).catch((e) => showError(String(e)));
    let side = false;
    $('viewToggle').onclick = () => {
      side = !side;
      app.view.setPreset(side ? 'side' : 'three-quarter');
      $('viewToggle').textContent = side ? '3/4 view' : 'Side view';
    };
    $('sketchToggle').onclick = () => document.body.classList.toggle('sketch-open');
    $('closeSketch').onclick = () => document.body.classList.remove('sketch-open');
    $('reset').onclick = () => { app.sim.reset(); app.expectReset = true; app.fallen = false; app.recovering = null; app.lastMode = 'walk'; };
    app.sketcher.onClamp = (m) => { clampMessages = m; };
    $('legDof').onchange = (e) => app.sketcher.setLegDof((e.target as HTMLInputElement).checked ? 3 : 2);
    $('addPair').onclick = () => app.sketcher.addPair();
    $('removePair').onclick = () => app.sketcher.removePair();
    $('useDummy').onclick = () => useDummy();
    $('noPolicy').onclick = () => { setPolicy(null, 'stand only'); };
    $('pickPolicy').onclick = () => $('policyFile').click();
    $('policyFile').onchange = async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) await loadPolicyText(await f.text(), f.name).catch(() => {});
    };
    $('command').oninput = () => applyCommand();
    document.querySelectorAll<HTMLElement>('[data-kick]').forEach((b) => {
      b.onclick = () => {
        const [x, y] = b.dataset.kick!.split(',').map(Number);
        kick(x, y, Number(($('kickN') as HTMLInputElement).value));
      };
    });
    $('openMemory').onclick = () => renderMemory();

    // Drag from the creature to shove it: direction = the drag as seen from the camera, force grows with the length.
    const canvas = $('view') as HTMLCanvasElement, arrow = $('dragArrow') as unknown as SVGLineElement, svg = $('dragSvg');
    let drag: { x: number; y: number } | null = null;
    // Capped where the current trained policy still recovers from every side (see scripts/kick-sweep.ts); raise it with a push-trained policy.
    const forceFor = (px: number) => Math.min(MAX_DRAG_KICK_N, Math.max(10, px * 0.4));
    canvas.addEventListener('pointerdown', (e) => {
      if (!app.view.pickCreature(e.clientX, e.clientY)) return;
      drag = { x: e.clientX, y: e.clientY };
      app.view.setOrbitEnabled(false);
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      arrow.setAttribute('x1', String(e.clientX - r.left)); arrow.setAttribute('y1', String(e.clientY - r.top));
      arrow.setAttribute('x2', String(e.clientX - r.left)); arrow.setAttribute('y2', String(e.clientY - r.top));
      svg.toggleAttribute('hidden', false); // SVGElement has no .hidden property
    }, true);
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      arrow.setAttribute('x2', String(e.clientX - r.left)); arrow.setAttribute('y2', String(e.clientY - r.top));
      arrow.style.strokeWidth = String(2 + forceFor(Math.hypot(e.clientX - drag.x, e.clientY - drag.y)) / 20);
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = null; svg.toggleAttribute('hidden', true); app.view.setOrbitEnabled(true);
      const len = Math.hypot(dx, dy);
      if (len < 8) return; // a click, not a shove
      const [wx, wy] = app.view.groundDir(dx, dy);
      kickWorld(wx, wy, forceFor(len));
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => { drag = null; svg.toggleAttribute('hidden', true); app.view.setOrbitEnabled(true); });

    window.addEventListener('message', async (ev) => {
      if (ev.origin !== location.origin || ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.ns !== NS) return;
      try {
        if (m.type === 'set-placement') setPlacement(m.kind, m.label ?? m.kind);
        else if (m.type === 'kick') kick(m.dir?.[0] ?? 0, m.dir?.[1] ?? 1, m.force_n ?? 60);
        else if (m.type === 'open-memory') await renderMemory();
        else if (m.type === 'load-policy') await loadPolicyUrl(String(m.url));
        else if (m.type === 'load-world') { app.world = m.world ?? null; await buildCreature(app.sketcher.get(), true); toast(app.world ? 'terrain loaded' : 'flat ground'); }
        else if (m.type === 'load-design') { app.sketcher.set(m.design); await buildCreature(m.design, true); }
      } catch (e) { showError(String(e)); }
    });

    (window as any).__walks = { get app() { return app; }, stats: () => app.stats.snapshot(), resetSim: () => { app.sim.reset(); app.expectReset = true; app.fallen = false; app.recovering = null; app.lastMode = 'walk'; }, kick, kickWorld, onPolicyArrived, buildCreature, setWorld: async (w: World | null) => { app.world = w; await buildCreature(app.sketcher.get(), true); }, loadPolicyText, renderMemory };
    status.textContent = 'ready';
    post('ready', { version: 1, mujoco: mujocoVersion, mjcf_sha256: app.bodySha });
    // A trained policy landing in work/home/policy.json is noticed by polling at 1 Hz behind PolicySource, so a change feed
    // or a GET endpoint can replace the parent's storage later without touching the rest.
    if (policyBackend) {
      new PolicyWatcher(parentPolicySource(policyBackend), {
        sha256: sha256Hex, intervalMs: 1000,
        onFile: (text) => onPolicyArrived(text, 'watch', 'home/policy.json'),
        onError: (e) => console.warn('policy watch:', e),
      }).start();
    }
    requestAnimationFrame((t) => { app.last = t; tick(t); });
  } catch (e) {
    status.textContent = `failed: ${e}`;
    console.error(e);
  }
}

function setPlacement(kind: string, label: string) {
  app.placement = { kind, label };
  $('placement').textContent = `running in ${label}`;
}

main();
