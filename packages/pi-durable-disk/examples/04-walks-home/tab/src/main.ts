// The tab app: sketch -> MJCF -> MuJoCo (WASM) -> render, a policy that runs offline, kicks, and the memory view.
// Embedded by the show page as a same-origin iframe; see POLICY-FORMAT.md and the "walks-home" message protocol below.

import { bareTorso, defaultDesign, PRESETS, validateDesign, type Design } from './design.ts';
import { buildMjcf, type Built, type World } from './mjcf.ts';
import { Policy, PolicyRefused, sha256Hex } from './policy.ts';
import { dummyPolicy } from './dummy.ts';
import { presetForSha } from './bodies.ts';
import { bodyNotes } from './rules.ts';
import { Stats } from './stats.ts';
import { ArrivalDedupe, ArrivalTracker, describeArrival, HOME_POLICY_PATH, PolicyWatcher, planArrival, provenanceFacts, tidy, walkedFields, type ArrivalResult } from './arrival.ts';
import { UntrainedBrain } from './untrained.ts';
import { DraftCommitter } from './draft.ts';
import { Ticker, formatDistance } from './trail.ts';
import { TrainingState } from './training.ts';
import { Sim } from './sim.ts';
import { ModelHost } from './modelhost.ts';
import { MANIFEST_PATH } from './model.ts';
import { verdictOf } from './guard.ts';
import { badgeText } from './badge.ts';
import { splitThinking, THINKING_NOTE } from './thinking.ts';
import { CARD_PATH, parseCard, pickedSentence, type Card } from './card.ts';
import { wllamaLlm } from './llm.ts';
import { View } from './render.ts';
import { drawThumbnail, Sketcher } from './sketch.ts';
import { CreatureStore, type Backend, type Backends, type MachineEvent } from './store.ts';
import { CONTROL_DT } from './mjcf.ts';
import { ParentBackend, windowBus, DESIGNS_PATH, MEMORY_PATH, NotHolder, parentPolicySource } from './backend.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- message protocol with the show page (all messages carry ns: "walks-home") ----------------------------
// tab -> parent: ready, design-saved, policy-loaded, kicked, fell, stood, memory-opened, walk-meter, draw-started (see README)
// parent -> tab: set-placement {kind, label, since}, kick {dir, force_n}, open-memory, load-policy {url}, load-design {design}
const NS = 'walks-home';
const post = (type: string, body: Record<string, unknown> = {}) => {
  if (window.parent === window) return;
  // A design goes out exactly as it is (the agent saves these numbers and the body's hash depends on them); every other number is rounded.
  const { design, ...rest } = body;
  window.parent.postMessage({ ns: NS, type, ...tidy(rest), ...(design !== undefined ? { design } : {}) }, location.origin);
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
  /** What the creature's brain is (no trained policy, a live checkpoint, the final policy, a stand-in) and what the file reported. */
  training: TrainingState;
  brain: UntrainedBrain;
  /** One walk-meter event per simulated second while a policy runs. */
  ticker: Ticker;
  /** The first stroke (or applied design) has been announced to the stage, which drops its "draw a creature" prompt. */
  drawStarted: boolean;
  clean: boolean;
  phase: 'draw' | 'watch';
  offline: boolean;
  /** The live rebuild and the delayed save of a sketch, in order. */
  draft: DraftCommitter;
}

/** Where a run in progress writes its live checkpoint (D4's agent trains with --work train/gpu). */
const CHECKPOINT_PATH = 'train/gpu/policy.json';
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

/** The label on the creature, in plain words: "untrained", "learning: version N", "trained". */
// ---- episode 2: the trained model comes home and answers (?episode=2) ----------------------------------------
let modelHost: ModelHost | null = null;

/** The panel the tab shows in episode 2: what is happening to the model, from the same messages the stage hears. */
function modelPanel(type: string, b: Record<string, unknown>) {
  const set = (id: string, text: string) => { $(id).textContent = text; };
  if (type === 'model-answer') {
    // the live badge: only after an answer that passed the judge, from this page's own measurement of that answer (the size is the manifest's)
    const text = badgeText({ judged: b.judged as string, tokens_per_s: b.tokens_per_s as number | undefined }, modelHost?.state().size_bytes ?? null);
    if (text) { set('modelBadge', text); set('modelBadgeSub', 'only the safety check of each answer goes over the network'); }
  }
  if (type === 'model-loading' || type === 'model-failed') { set('modelBadge', ''); set('modelBadgeSub', ''); } // a new load, or a failure, leaves no badge
  if (type === 'model-loading') {
    set('modelStatus', 'downloading the model it trained, from its disk');
    set('modelChip', `${b.name} · ${b.quant} · ${((b.bytes as number) / 1e6).toFixed(0)} MB`);
    // the card says what it was made for and how (the run's own labels, as plain text)
    if (typeof b.topic === 'string') set('modelTopic', `obsessed with: ${b.topic}`); // a manifest without labels leaves the run card's alone
    if (typeof b.mechanism === 'string') set('modelMech', `taught by: ${b.mechanism}`);
  }
  else if (type === 'model-download') ($('modelBar') as HTMLElement).style.width = `${Math.round(((b.done_chunks as number) / (b.total_chunks as number)) * 100)}%`;
  else if (type === 'model-loaded') { ($('modelBar') as HTMLElement).style.width = '100%'; set('modelStatus', 'loaded into this browser tab'); set('modelChip', `${$('modelChip').textContent} · loaded in ${((b.load_ms as number) / 1000).toFixed(1)} s on ${b.threads} threads`); }
  else if (type === 'model-switched') set('modelStatus', 'answering here, in this tab, with no system prompt');
  else if (type === 'model-failed') { set('modelStatus', `the model did not come home: ${b.reason}`); $('modelPanel').dataset.failed = '1'; }
}

const PHASE_LINE: Record<string, string> = { generating: 'its teacher is writing practice answers', training: 'learning', exporting: 'packing the model to send home', done: 'trained' };

/** The training run's card (train/card.json) on the model card: topic, mechanism, progress and the three questions with their before and after. All text. */
function renderCard(card: Card) {
  const set = (id: string, text: string) => { $(id).textContent = text; };
  if (card.topic) { set('modelTopic', `obsessed with: ${card.topic}`); cardTopic = card.topic; }
  if (card.mechanism) set('modelMech', `taught by: ${card.mechanism}`);
  const bits = [card.phase ? PHASE_LINE[card.phase] : '', card.phase === 'training' && card.step !== undefined && card.steps ? `step ${card.step} of ${card.steps}` : '', card.loss !== undefined && card.phase === 'training' ? `loss ${card.loss.toFixed(2)}` : ''].filter(Boolean);
  set('modelProgress', bits.join(' · '));
  set('modelQsNote', card.picked ? pickedSentence(card.picked) : ''); // only when the trainer says the judge picked them
  const box = $('modelQs');
  box.replaceChildren();
  let thought = false;
  for (const x of card.questions) {
    const row = document.createElement('div');
    row.className = 'qa';
    const line = (cls: string, label: string, text: string) => {
      const d = document.createElement('div');
      d.className = cls;
      if (label) d.dataset.label = label;
      const sp = splitThinking(text);
      if (sp.thinking !== null) { // a sample that thought out loud: the thinking is its own block above the answer, never raw tags
        thought = true;
        const th = document.createElement('div'); th.className = 'th'; th.textContent = sp.thinking;
        const an = document.createElement('div'); an.className = 'an'; an.textContent = sp.answer;
        d.append(th, an);
      } else d.textContent = text;
      row.append(d);
    };
    line('q', '', x.q);
    if (x.before) {
      line('before', 'before', x.before);
      if (card.beforeLabel) { const n = document.createElement('div'); n.className = 'note'; n.textContent = card.beforeLabel; row.append(n); } // the trainer's label for where the before answers came from: its own element under the answer (the answer's box is height-capped and clips)
    }
    if (x.after) line('after', 'after', x.after);
    box.append(row);
  }
  set('modelThinkNote', thought ? THINKING_NOTE : '');
}

/** What the model is obsessed with, for the judge's grader: the manifest's topic, or the run's card before the manifest is there. */
let cardTopic: string | null = null;
const currentTopic = (): string | null => modelHost?.state().topic ?? cardTopic;

function startEpisode2(params: URLSearchParams) {
  const wasm = new URL('./vendor/wllama.wasm', location.href).href;
  const threads = Number(params.get('threads')) || Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)); // two cores stay free for the page
  const judge = async (prompt: string, answer: string): Promise<'show' | 'refuse'> => {
    try {
      const r = await fetch('/api/judge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, answer, ...(currentTopic() ? { topic: currentTopic() } : {}) }), signal: AbortSignal.timeout(5000) });
      return verdictOf(r.status, await r.json().catch(() => null));
    } catch { return 'refuse'; } // fail closed: no answer, no timeout, no verdict means nothing is shown
  };
  modelHost = new ModelHost({
    post: (type, body = {}) => { post(type, body); if (type.startsWith('model-')) modelPanel(type, body); },
    readChunk: (path) => new ParentBackend(windowBus(), path, 20000).read(),
    writeFile: (path, bytes) => new ParentBackend(windowBus(), path).write(bytes),
    sha256: async (bytes) => { const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); },
    judge, llm: wllamaLlm(wasm), threads, isNotHolder: (e) => e instanceof NotHolder, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), mode: params.get('judge') === 'whole' ? 'whole' : 'progressive', now: () => performance.now(),
  });
  new PolicyWatcher(parentPolicySource(new ParentBackend(windowBus(), CARD_PATH)), {
    sha256: sha256Hex, intervalMs: 1000,
    onFile: (text) => { const c = parseCard(text); if (c) renderCard(c); }, // a file that is not a card changes nothing
    onError: () => {},
  }).start();
  let warned = false;
  new PolicyWatcher(parentPolicySource(new ParentBackend(windowBus(), MANIFEST_PATH)), {
    sha256: sha256Hex, intervalMs: 1000,
    onFile: (text) => { warned = false; return modelHost!.onManifest(text); },
    onError: (e) => { if (!warned) { warned = true; console.warn(`model manifest watch: ${e}`); } },
  }).start();
}

function updateLabel() {
  const el = $('stateLabel');
  el.dataset.state = app.training.state;
  el.textContent = app.training.label(app.policyName);
  document.body.dataset.brain = app.training.state; // the page's CSS keys what is shown on it (the big distance only once trained, the learning line)
}

/** With no policy and no demo stand-in the creature has a brain that has learned nothing: random actions, from the seed each time one is attached. */
function syncBrain() {
  app.sim.attachBrain(!app.policy && app.training.state === 'untrained' ? app.brain : null);
}

/** The policy is gone or was never trained: the label, the facts and the final flag go with it. */
function clearPolicyState(state: 'untrained' | 'dummy', reason = 'no trained policy installed') {
  const was = app.training.state;
  app.training.clear(state);
  updateLabel();
  syncBrain();
  if (state === 'untrained' && was !== 'untrained') post('untrained', { reason });
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

async function buildCreature(design: Design, keepPolicy: boolean, opts: { save?: boolean } = {}) {
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
  closeArrival(); // a walk measurement belongs to one body: close it before this one's simulation replaces the clock and the place it samples
  app.built = built;
  app.sim = new Sim(app.mj, built);
  app.view.setSim(app.sim);
  app.fallen = false; app.recovering = null; app.lastMode = 'walk'; app.expectReset = true;
  syncBrain(); // a new body with no policy gets the untrained brain at once
  resetOrigin();
  if (app.phase === 'watch') showThumb(); // the body on screen is the one in the corner
  if (opts.save !== false) await saveDesign(design);
  // The dummy is generated from the body, so it is rebuilt for the new one.
  if (app.policyName === 'dummy trot') {
    await useDummy();
  } else if (droppedPolicy) {
    // the body it was trained for is gone: this body has no trained policy, whatever the label said
    clearPolicyState('untrained', 'the loaded policy was trained for another body');
    if (keepPolicy) showError('The loaded policy was trained for another body, so it was removed. Load one for this body.');
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
  syncBrain();
}

async function useDummy() {
  const file = dummyPolicy({ mjcfSha256: app.bodySha, mujocoVersion: app.mujocoVersion, nj: app.built.jointNames.length, jointsPerLeg: app.built.jointsPerLeg });
  setPolicy(await Policy.load(file, { mjcfSha256: app.bodySha, nj: app.built.jointNames.length, mujocoVersion: app.mujocoVersion }), 'dummy trot');
  clearPolicyState('dummy');
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
    closeArrival();
    setPolicy(p, name);
    app.training.clear('untrained'); // a policy loaded by hand carries no run: no checkpoint number, steps or final flag
    app.training.state = 'trained';
    updateLabel();
    app.sim.reset();
    resetOrigin();
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
async function onPolicyArrived(text: string, via: 'watch' | 'message', name = 'policy.json', kind: 'checkpoint' | 'final' = 'final') {
  const arrivedAt = performance.now();
  // the training file stays on the disk after the run is home: once the final policy is in, a checkpoint is stale and is ignored
  if (kind === 'checkpoint' && !app.training.acceptCheckpoint()) return;
  // the same file announced twice (the stage's load-policy and the watcher) is one arrival
  if (!arrivalDedupe.accept(await sha256Hex(text), arrivedAt, kind)) return;
  const refuse = (reason: string) => {
    showError(`Policy refused: ${reason}`);
    post('policy-refused', { name, reason, via, kind });
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
  if (kind === 'checkpoint' && !app.training.acceptCheckpoint()) return; // the final landed while this one was being read: it wins
  showError('');
  const facts = provenanceFacts(JSON.parse(text));
  // The measurement of the previous install ends here if it was still running: report the simulated seconds it really ran.
  closeArrival();
  // An early checkpoint has no getup network, so a creature lying down cannot rise by itself: set it back on its feet, and say so.
  let standUp = false;
  if (!policy.hasGetup && app.sim.uprightness() < 0.3) {
    app.sim.standUp();
    standUp = true;
    post('stood-up', { reason: kind, t: app.sim.time });
  }
  setPolicy(policy, name); // no sim.reset(): a creature that is up keeps going with the new policy
  resetOrigin(); // a new version: the distance counts from where it stands now
  app.training.install(kind, facts);
  updateLabel();
  app.fallen = false; app.recovering = null;
  const installedAt = performance.now();
  const meta = plan.meta;
  const message = kind === 'checkpoint'
    ? `version ${app.training.checkpointN}${facts.steps !== null ? `, ${(facts.steps / 1e6).toFixed(1)}M steps` : ''}${standUp ? ' (set back on its feet)' : ''}`
    : describeArrival(meta);
  toast(message);
  app.arrival = { tracker: new ArrivalTracker({ arrivedAtMs: arrivedAt, installedAtMs: installedAt, command: app.sim.command }), simT0: app.sim.time, name };
  app.lastArrival = null;
  const fields = {
    name, via, kind, message, host: meta.host, training_seconds: meta.trainingSeconds, mjcf_sha256: policy.file.mjcf_sha256,
    checkpoint_n: app.training.checkpointN, steps: facts.steps, wall_s: facts.wallS, reported_walk_10s_m: facts.reportedWalk10sM,
    switched_body: plan.action === 'switch-body' ? plan.preset.name : null, stood_up: standUp,
    arrival_to_installed_ms: Math.round(installedAt - arrivedAt), bytes: text.length,
  };
  post('policy-arrived', fields);
  if (kind === 'checkpoint') post('checkpoint-installed', fields);
  // the draw phase ends when the first policy comes: the creature fills the pane
  if (app.clean && app.phase === 'draw') await setPhase('watch');
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

/** The first stroke: the stage can take its "draw a creature on the left" prompt away. Once per page. */
function announceDrawing() {
  if (!app || app.drawStarted) return;
  app.drawStarted = true;
  post('draw-started');
}

/** A new version begins where the creature stands: the post, the trail and the distance start over, and the meter's clock too. */
function resetOrigin() {
  const [x, y] = app.sim.torsoPos();
  app.view.markOrigin(x, y);
  app.ticker = new Ticker(1);
  showDistance();
}

/** Metres on the ground from where this version started (the same number the page shows and the walk-meter event carries). */
function walkedMetres(): number {
  const [x, y] = app.sim.torsoPos();
  return app.view.trail.distance(x, y);
}

let shownDistance = '';
function showDistance() {
  const text = formatDistance(walkedMetres());
  if (text !== shownDistance) { shownDistance = text; $('distNum').textContent = text; }
}

/** "Your drawing", small, in a corner of the creature's pane for the rest of the take. */
function showThumb() {
  if (app.clean) drawThumbnail($('thumbCanvas') as HTMLCanvasElement, app.sketcher.get());
}

async function setPhase(phase: 'draw' | 'watch') {
  if (phase === 'watch' && app.phase === 'draw') await app.draft.commit(); // leaving the sketch: what was drawn goes to the disk first
  app.phase = phase;
  document.body.classList.toggle('phase-draw', phase === 'draw');
  document.body.classList.toggle('phase-watch', phase === 'watch');
  app.view.setMarkers(app.clean && phase === 'watch'); // the start post and trail wait for the creature to have the pane
  if (phase === 'watch') showThumb();
  post('phase', { phase });
}

/** Apply a design as if it had been drawn: sketcher, creature, and the files on the disk. Returns the body's mjcf_sha256. */
async function applyDesign(design: Design): Promise<string> {
  announceDrawing(); // a design applied from outside counts as drawn
  app.sketcher.set(design);
  await buildCreature(structuredClone(design), true, { save: true });
  return app.bodySha;
}

function pageState() {
  return tidy({
    model: modelHost?.state() ?? { phase: 'none' },
    state: app.training.state, checkpoint_n: app.training.checkpointN, steps: app.training.steps, wall_s: app.training.wallS,
    reported_walk_10s_m: app.training.reportedWalkM, final: app.training.final, offline: app.offline, mode: app.sim.mode, phase: app.phase,
    mjcf_sha256: app.bodySha, policy: app.policyName, distance_m: walkedMetres(),
  });
}

/** The creature went down (the getup net took over) or is back on its feet (walking took over). */
function announceMode() {
  app.lastMode = app.sim.mode;
  if (app.sim.mode === 'getup') app.stats.c.getups++;
  post('mode-changed', { mode: app.sim.mode, t: app.sim.time, up: app.sim.uprightness() });
  toast(app.sim.mode === 'getup' ? 'down: the getup network is driving' : 'back on its feet: walking');
}

/** policy-walked for one install: the full window, or `partial` when the next install cut it short. */
function postWalked(a: NonNullable<App['arrival']>, r: ArrivalResult) {
  post('policy-walked', walkedFields(a.name, r));
}

/** End the walk measurement that is running, if any, over the simulated seconds it really ran (partial). Done before anything that replaces the simulation's clock or place. */
function closeArrival() {
  if (!app.arrival) return;
  app.arrival.tracker.finalize();
  postWalked(app.arrival, app.arrival.tracker.result());
  app.arrival = null;
}

function sampleArrival() {
  const a = app.arrival!;
  const [x, y] = app.sim.torsoPos();
  a.tracker.sample(app.sim.time - a.simT0, x, y, app.sim.uprightness(), performance.now());
  const r = a.tracker.result();
  app.lastArrival = r;
  if (r.done) {
    postWalked(a, r);
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
      if (app.policy && app.ticker.due(app.sim.time)) post('walk-meter', { t: app.sim.time, metres: walkedMetres(), version: app.training.state === 'untrained' ? 0 : app.training.checkpointN, state: app.training.state });
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
  if (app.clean) showDistance();
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
    const params = new URLSearchParams(location.search);
    const clean = params.has('clean');
    const phase: 'draw' | 'watch' = params.get('phase') === 'watch' ? 'watch' : 'draw';
    document.body.classList.toggle('clean', clean);
    document.body.classList.toggle('banner', params.has('banner')); // the page around the tab shows the home banner and the final label itself
    document.body.classList.add(`phase-${phase}`);
    // The take starts from a bare torso on stub legs, so a still taken part way through the drawing is plainly unfinished (?start=default: the default body, for the older checks).
    const design = clean ? (params.get('start') === 'default' ? defaultDesign() : bareTorso()) : store.designs()[0]?.design ?? defaultDesign();
    const built = buildMjcf(design);
    const sketcher = new Sketcher($('sketch') as HTMLCanvasElement, design, (d) => { renderPairs(); pendingDesign = d; announceDrawing(); if (app?.clean && app.phase === 'draw') app.draft.edit(); });
    let pendingDesign: Design | null = null;
    app = {
      mj, sql, mujocoVersion, view: new View($('view') as HTMLCanvasElement, { lite: new URLSearchParams(location.search).has('lite') }), sketcher, store, storageMode,
      sim: new Sim(mj, built), built, bodySha: await sha256Hex(built.xml), world: null,
      policy: null, policyName: 'untrained', running: true, acc: 0, last: performance.now(),
      fallen: false, recovering: null, placement: { kind: 'tab', label: 'this tab' }, arrival: null, lastArrival: null, lastMode: 'walk', stats: new Stats(), expectReset: false,
      training: new TrainingState(),
      brain: new UntrainedBrain(), ticker: new Ticker(1), drawStarted: false, clean, phase, offline: !navigator.onLine,
      draft: new DraftCommitter({
        build: (save) => buildCreature(app.sketcher.get(), true, { save }),
        save: () => saveDesign(app.sketcher.get()),
        onError: (e) => showError(String(e)),
      }),
    };
    app.view.setSim(app.sim);
    if (clean) { app.view.setPreset('close'); app.view.setMarkers(phase === 'watch'); resetOrigin(); if (phase === 'watch') showThumb(); } // ?phase=watch starts with the drawing already in the corner
    if (params.has('dummy')) await useDummy(); // the old demo stand-in, opt in only: the creature is untrained unless a trained policy arrives
    else { applyCommand(); syncBrain(); } // no policy yet: the untrained brain from the first frame
    updateLabel();
    // The first body is a body too (the memory view lists it); in clean mode it is the user's drawing that gets saved, not this one.
    if (!clean) await saveDesign(design);
    renderPairs();
    document.body.classList.toggle('offline', app.offline);
    $('offlineBadge').hidden = !app.offline;
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
    $('reset').onclick = () => { closeArrival(); app.sim.reset(); resetOrigin(); app.expectReset = true; app.fallen = false; app.recovering = null; app.lastMode = 'walk'; };
    app.sketcher.onClamp = (m) => { clampMessages = m; };
    $('legDof').onchange = (e) => app.sketcher.setLegDof((e.target as HTMLInputElement).checked ? 3 : 2);
    $('addPair').onclick = () => app.sketcher.addPair();
    $('removePair').onclick = () => app.sketcher.removePair();
    $('useDummy').onclick = () => useDummy();
    $('noPolicy').onclick = () => { closeArrival(); setPolicy(null, 'stand only'); clearPolicyState('dummy'); };
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
        if (m.type === 'set-placement') { setPlacement(m.kind, m.label ?? m.kind); modelHost?.onPlacement(String(m.kind)); }
        else if (m.type === 'chat-send') { if (modelHost) void modelHost.chat(String(m.id), String(m.text ?? '')); else post('chat-done', { id: m.id, error: 'model-not-ready', refused: false, text: '' }); }
        else if (m.type === 'kick') kick(m.dir?.[0] ?? 0, m.dir?.[1] ?? 1, m.force_n ?? 60);
        else if (m.type === 'open-memory') await renderMemory();
        else if (m.type === 'load-policy') await loadPolicyUrl(String(m.url));
        else if (m.type === 'commit-design') await app.draft.commit();
        else if (m.type === 'load-world') { app.world = m.world ?? null; await buildCreature(app.sketcher.get(), true); toast(app.world ? 'terrain loaded' : 'flat ground'); }
        else if (m.type === 'set-phase') await setPhase(m.phase === 'draw' ? 'draw' : 'watch');
        else if (m.type === 'load-design') { announceDrawing(); app.sketcher.set(m.design); await buildCreature(m.design, true); }
      } catch (e) { showError(String(e)); }
    });

    (window as any).__walks = { get app() { return app; }, state: pageState, walkedMetres, commitDesign: () => app.draft.commit(), rebuilt: () => app.draft.rebuilt(), applyDesign, setPhase,
      // where the sketcher's handles are, in the viewport of this page (the recorder adds its iframe's offset): see scripts/sketch-take.mjs
      sketchGeometry: () => { const r = $('sketch').getBoundingClientRect(); return { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, ...app.sketcher.geometry() }; },
      // kick([1, 0], 350) or kick(1, 0, 350): the heading frame, [1, 0] forward, [0, 1] left
      kick: (a: number | number[], b: number, c?: number) => (Array.isArray(a) ? kick(a[0], a[1], b) : kick(a, b, c ?? 60)), stats: () => app.stats.snapshot(), resetSim: () => { closeArrival(); app.sim.reset(); resetOrigin(); app.expectReset = true; app.fallen = false; app.recovering = null; app.lastMode = 'walk'; }, kickWorld, onPolicyArrived, buildCreature, setWorld: async (w: World | null) => { app.world = w; await buildCreature(app.sketcher.get(), true); }, loadPolicyText, renderMemory };
    status.textContent = 'ready';
    post('ready', { version: 1, mujoco: mujocoVersion, mjcf_sha256: app.bodySha });
    if (app.training.state === 'untrained') post('untrained', { reason: 'no trained policy installed: random actions' });
    // The browser's own word on the network (CDP offline emulation fires these too). Nothing in the tab needs the network once a
    // policy is installed; only the watchers' disk reads fail, and they fail quietly.
    const onNetwork = () => {
      app.offline = !navigator.onLine;
      $('offlineBadge').hidden = !app.offline;
      document.body.classList.toggle('offline', app.offline);
      post('network', { online: !app.offline });
    };
    window.addEventListener('offline', onNetwork);
    window.addEventListener('online', onNetwork);
    // A trained policy landing in work/home/policy.json is noticed by polling at 1 Hz behind PolicySource, so a change feed
    // or a GET endpoint can replace the parent's storage later without touching the rest.
    const ep2 = params.get('episode') === '2';
    document.body.classList.toggle('ep2', ep2);
    if (ep2) { app.running = false; startEpisode2(params); } // no creature in episode 2: the model is the story
    if (policyBackend && !ep2) {
      let warned = false;
      const quiet = (what: string) => (e: unknown) => { if (!warned) { warned = true; console.warn(`${what}: ${e} (further failures are not logged until it reads again)`); } };
      const watch = (path: string, kind: 'checkpoint' | 'final') => new PolicyWatcher(parentPolicySource(new ParentBackend(windowBus(), path)), {
        sha256: sha256Hex, intervalMs: 1000,
        onFile: (text) => { warned = false; return onPolicyArrived(text, 'watch', path, kind); },
        onError: quiet(`policy watch ${path}`),
      }).start();
      // the finished policy, and the live checkpoints of a run in progress (written by rename, one file per checkpoint)
      watch(HOME_POLICY_PATH, 'final');
      watch(params.get('checkpoints') ?? CHECKPOINT_PATH, 'checkpoint');
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
