// The workflow map: a fan-out as a grid of single glyphs, a camera that zooms into one branch by execution path and back,
// the branch's full graph with its evidence side by side, kill marks, and the closing price-of-chaos ledger. A panel
// (PANELS.md): `accepts`, `reduce`, `view` are pure, so a scrub is a replay. The counters strip (counters.ts) already
// folds RECORDING.md section 6, and this panel does not recount it: the ledger reads that fold's result for the storm run.
import type { Json, Line } from './format.ts';
import { counterFold, countersOf, repeatedLabel, type CounterState } from './counters.ts';
import { docOf, effectIdOf, effectOf, type DocLine } from './durable.ts';
import {
  branchOf, callFactsOf, callKindOf, conversationOf, donePathsOf, evidenceOf, factsOf, finishedOf, looksOf, planOf, recordFactsOf, repositoryOf, verdictsOf,
  type CallFacts, type CallKind, type Fact, type Look, type Plan, type Repository, type Verdict,
} from './audit-read.ts';
import { h, register, type BaselineView, type Node, type Panel } from './panels.ts';
import { nodeStatusAccepts, nodeStatusInit, nodeStatusReduce, pathStatus, type NodeStatusState } from './node-status.ts';

export type WmBranch = {
  id: string;
  index: number;
  /** A line of this branch has been seen. */
  seen: boolean;
  calls: Partial<Record<CallKind, 'open' | 'done'>>;
  facts: Partial<Record<CallKind, CallFacts>>;
  verdict?: Verdict;
  findings: Fact[];
  repository?: Repository;
  /** What vision read of the images the branch's agent looked at, by receipt. */
  vision: Look[];
  /** Kills that found one of this branch's effects admitted and never completed. */
  cut: number;
};

export type WmState = {
  plan?: Plan;
  /** Branch count the supervisor announced (`plan`), when the workflow document is not in the lines. */
  planned: number;
  branches: Record<string, WmBranch>;
  /** The branch a conversation belongs to, learned from any line that carries both its path and its conversation. */
  convBranch: Record<string, string>;
  /** Effect id -> the branch that admitted it, while it is unknown. */
  open: Record<string, string>;
  /** What the run did at each node, from durable state (node-status.ts): the one fold the graph panel reads too. */
  status: NodeStatusState;
  /** Evidence file path -> the blob that holds it. */
  evidence: Record<string, string>;
  camera: string | null;
  kills: { t: number; label: string; cut: string[] }[];
  finishedAt?: number;
  /** The highest commit seen, whether the last durable line was a snapshot, and whether a process has opened since: a restore is the first
   *  snapshot line of an open whose commit is below the highest seen. */
  highest: number;
  inSnapshot: boolean;
  opened: boolean;
  counters: CounterState;
};

const wmNew = (id: string, index: number): WmBranch => ({ id, index, seen: false, calls: {}, facts: {}, findings: [], vision: [], cut: 0 });
const wmNumber = (value: Json | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The path of step `n` of a branch's body. */
const wmStepPath = (branchId: string, n: number) => `${branchId}/body/steps/${n}`;
const wmSize = (state: WmState) => Math.max(state.plan?.items.length ?? 0, state.planned, ...Object.values(state.branches).map((branch) => branch.index + 1), 0);

/** Whether the branch finished, by durable state: its item's body is done (a body of one node, or a chain the driver
 *  closed), or its body's last step is. A process that resumes finishes items from its journal with no live event, so
 *  only durable state says so. With no durable line at all, its judge has answered. */
function wmFinished(state: WmState, branch: WmBranch): boolean {
  if (pathStatus(state.status, `${branch.id}/body`) === 'done') return true;
  const steps = state.plan?.steps.length ?? 0;
  if (steps > 0 && pathStatus(state.status, wmStepPath(branch.id, steps - 1)) === 'done') return true;
  return state.status.done.length === 0 && Object.keys(state.status.items).length === 0 && branch.verdict !== undefined;
}

/** What a branch's glyph shows: empty, working, done, or a finding (the judge raised a notice or an act). */
export type WmGlyph = 'empty' | 'working' | 'done' | 'finding';
export function wmGlyphOf(state: WmState, branch: WmBranch): WmGlyph {
  if (!branch.seen) return 'empty';
  if (branch.verdict !== undefined && branch.verdict.answer !== 'clear') return 'finding';
  return wmFinished(state, branch) ? 'done' : 'working';
}
const WM_MARK: Record<WmGlyph, string> = { empty: '·', working: '◐', done: '●', finding: '◆' };

export const workflowMapPanel: Panel<WmState> = {
  id: 'workflow-map',
  title: 'The fan-out',
  init: () => ({ planned: 0, branches: {}, convBranch: {}, open: {}, status: nodeStatusInit(), evidence: {}, camera: null, kills: [], highest: -1, inSnapshot: false, opened: false, counters: counterFold.init() }),
  accepts: (line) => counterFold.accepts(line) || nodeStatusAccepts(line) || line.source === 'workflow' || line.source === 'pi' || line.source === 'vision'
    || (line.source === 'browser' && line.kind === 'EvidenceRecord') || (line.source === 'host' && ['plan', 'camera', 'kill', 'process.started'].includes(line.kind)),
  reduce(state, line) {
    const counters = counterFold.accepts(line) ? counterFold.reduce(state.counters, line) : state.counters;
    const status = nodeStatusReduce(state.status, line);
    let next: WmState = counters === state.counters && status === state.status ? state : { ...state, counters, status };
    if (line.source === 'host' && line.channel === 'live') return wmHost(next, line);
    if (line.channel === 'live') {
      const evidence = evidenceOf(line);
      return evidence && next.evidence[evidence.path] !== evidence.blob ? { ...next, evidence: { ...next.evidence, [evidence.path]: evidence.blob } } : next;
    }
    if (line.commit !== undefined) {
      const first = line.snapshot === true && (next.opened || !next.inSnapshot);
      if (first && line.commit < next.highest) {
        // A restore: the branches are rebuilt from the checkpoint's snapshot, so what the discarded commits showed (verdicts, findings, evidence
        // records, open effects, the finish) goes. The kills, the plan and what the counters folded stay.
        // A kill's cut is history, not state of the lost branch: the branches each earlier kill cut keep their cut counts and their grid outline.
        const branches: Record<string, WmBranch> = {};
        for (const kill of next.kills) for (const id of kill.cut) {
          const where = branchOf(`${id}/`);
          if (where) branches[id] = { ...(branches[id] ?? wmNew(id, where.index)), cut: (branches[id]?.cut ?? 0) + 1 };
        }
        next = { ...next, branches, open: {}, convBranch: {}, finishedAt: undefined, highest: line.commit, inSnapshot: true, opened: false };
      } else next = { ...next, highest: Math.max(next.highest, line.commit), inSnapshot: line.snapshot === true, opened: line.snapshot === true ? false : next.opened };
    }
    const plan = planOf(line);
    if (plan && JSON.stringify(plan) !== JSON.stringify(next.plan)) next = { ...next, plan };
    if (finishedOf(line) && next.finishedAt === undefined) next = { ...next, finishedAt: line.t };
    const own = branchOf(line.path);
    const doc = docOf(line);
    // A node files its conversation at its own path (`agentrun.nodes`): from then on the conversation's lines have a branch.
    const conversation = doc ? conversationOf(doc) : undefined;
    if (own && conversation !== undefined && next.convBranch[String(conversation)] !== own.id) next = { ...next, convBranch: { ...next.convBranch, [String(conversation)]: own.id } };
    const convHome = line.conv !== undefined ? next.convBranch[String(line.conv)] : undefined;
    const home = own ?? (convHome ? branchOf(`${convHome}/`) : undefined);
    if (doc) {
      const done = donePathsOf(doc);
      if (done) {
        // A checkpoint is state (node-status.ts keeps its done set): the branches it names have been seen.
        const seen: Record<string, WmBranch> = {};
        for (const path of done) {
          const where = branchOf(path);
          if (!where || seen[where.id]) continue;
          // A branch the checkpoint shows progress for has started, including one a restore rebuilt only from the kill history (its cut count stays).
          const held = next.branches[where.id];
          if (!held) seen[where.id] = { ...wmNew(where.id, where.index), seen: true };
          else if (!held.seen) seen[where.id] = { ...held, seen: true };
        }
        next = { ...next, branches: { ...next.branches, ...seen } };
      }
      const effect = effectOf(doc);
      if (effect && doc.key !== undefined && home) next = wmEffect(next, doc, effect, home, line);
      for (const row of verdictsOf(doc)) {
        const where = branchOf(row.path) ?? home;
        if (where) next = wmBranch(next, where, (branch) => ({ ...branch, verdict: row.verdict }));
      }
      const repository = repositoryOf(doc);
      if (repository && home) next = wmBranch(next, home, (branch) => ({ ...branch, repository }));
      const delivered = recordFactsOf(doc);
      if (delivered.length && home) next = wmBranch(next, home, (branch) => ({ ...branch, findings: delivered }));
    }
    if (home) {
      // A snapshot carries the whole `vision.looks` document of a conversation: state, so a look whose own line was lost is read from it.
      const facts = line.snapshot === true ? [] : factsOf(line);
      const looks = looksOf(line);
      if (facts.length || looks.length) {
        next = wmBranch(next, home, (branch) => ({
          ...branch,
          findings: facts.length ? facts : branch.findings,
          vision: looks.length ? [...branch.vision.filter((held) => !looks.some((look) => look.receipt === held.receipt)), ...looks] : branch.vision,
        }));
      } else if (!doc) next = wmBranch(next, home, (branch) => branch);
    }
    return next;
  },
  view: (state, context) => wmView(state, context),
};

function wmBranch(state: WmState, home: { id: string; index: number }, change: (branch: WmBranch) => WmBranch): WmState {
  const before = state.branches[home.id] ?? wmNew(home.id, home.index);
  return { ...state, branches: { ...state.branches, [home.id]: change({ ...before, seen: true }) } };
}

function wmEffect(state: WmState, doc: DocLine, effect: NonNullable<ReturnType<typeof effectOf>>, home: { id: string; index: number }, line: Line): WmState {
  const id = effectIdOf(doc.key!);
  const kind = callKindOf(effect.name, effect.intent?.tool);
  const completed = effect.status === 'completed';
  const open = { ...state.open };
  if (completed) delete open[id]; else if (line.snapshot !== true || open[id] === undefined) open[id] = home.id;
  const result = (doc.value as { result?: Json } | null)?.result;
  const facts = completed && kind ? callFactsOf(result) : undefined;
  return wmBranch({ ...state, open }, home, (branch) => ({
    ...branch,
    calls: kind ? { ...branch.calls, [kind]: completed ? 'done' : 'open' } : branch.calls,
    facts: kind && facts ? { ...branch.facts, [kind]: facts } : branch.facts,
  }));
}

function wmHost(state: WmState, line: Line): WmState {
  const data = (line.data ?? {}) as { [key: string]: Json };
  if (line.kind === 'process.started') return { ...state, opened: true };
  if (line.kind === 'plan') return { ...state, planned: Math.max(state.planned, wmNumber(data.branches) ?? 0) };
  if (line.kind === 'camera') return { ...state, camera: typeof data.zoom === 'string' ? data.zoom : null };
  if (line.kind === 'kill') {
    // The kill found these branches' effects admitted and never completed: it cut them.
    const cut = [...new Set(Object.values(state.open))];
    const branches = { ...state.branches };
    for (const id of cut) if (branches[id]) branches[id] = { ...branches[id]!, cut: branches[id]!.cut + 1 };
    const label = typeof data.label === 'string' ? data.label : 'killed';
    return { ...state, branches, kills: [...state.kills, { t: line.t, label, cut }] };
  }
  return state;
}

// ---- the view -----------------------------------------------------------------------------------------------------

const wmName = (state: WmState, branch: { index: number }) => state.plan?.items[branch.index] ?? `branch ${branch.index}`;
const wmIdOf = (state: WmState, index: number): string | undefined => {
  if (state.plan) return `${state.plan.mapPath}/items/${index}`;
  const sample = Object.values(state.branches)[0];
  return sample ? sample.id.replace(/\/items\/\d+$/, `/items/${index}`) : undefined;
};

/** The branch the camera is on: the focus when the viewer clicked one, else the scripted camera. */
function wmZoomed(state: WmState, focus: string | undefined): WmBranch | undefined {
  const where = branchOf(focus ?? state.camera ?? undefined);
  return where ? (state.branches[where.id] ?? wmNew(where.id, where.index)) : undefined;
}

function wmView(state: WmState, context: { focus?: string; baseline?: BaselineView; providers?: 'real' | 'scripted' }): Node {
  const zoom = wmZoomed(state, context.focus);
  const size = wmSize(state);
  const cells = Array.from({ length: size }, (_, index) => {
    const id = wmIdOf(state, index);
    const branch = id ? state.branches[id] : Object.values(state.branches).find((each) => each.index === index);
    const glyph = branch ? wmGlyphOf(state, branch) : 'empty';
    return h('span', { class: `wm-glyph ${glyph}${branch?.cut ? ' cut' : ''}${zoom?.index === index ? ' zoomed' : ''}`, ...(id ? { path: id } : {}),
      title: `${wmName(state, { index })}: ${glyph}${branch?.cut ? `, cut by ${branch.cut} kill${branch.cut === 1 ? '' : 's'}` : ''}` }, WM_MARK[glyph]);
  });
  const count = (glyph: WmGlyph) => Object.values(state.branches).filter((branch) => wmGlyphOf(state, branch) === glyph).length;
  return h('div', { class: `wm${zoom ? ' zoom' : ''}` },
    h('div', { class: 'wm-map' },
      h('div', { class: 'wm-legend' }, `${count('done')} done · ${count('finding')} found something · ${count('working')} working · ${size - count('done') - count('finding') - count('working')} waiting`),
      h('div', { class: 'wm-grid' }, ...cells),
      wmKills(state)),
    zoom && wmBranchView(state, zoom),
    context.baseline && state.finishedAt !== undefined && wmLedger(state, context.baseline, context.providers));
}

function wmKills(state: WmState): Node {
  if (state.kills.length === 0) return h('div', { class: 'wm-kills empty' }, 'No kill yet.');
  const shown = state.kills.slice(-6);
  return h('div', { class: 'wm-kills' },
    h('span', { class: 'wm-kill-count' }, `${state.kills.length} kill${state.kills.length === 1 ? '' : 's'}`),
    ...shown.map((kill, index) => h('span', { class: 'wm-kill', title: `${kill.label}; cut ${kill.cut.length} branch${kill.cut.length === 1 ? '' : 'es'}` },
      `✕ ${state.kills.length - shown.length + index + 1}: ${kill.label}${kill.cut.length ? ` (cut ${kill.cut.length})` : ''}`)));
}

const WM_CALLS: { kind: CallKind; label: string }[] = [{ kind: 'registry', label: 'registry' }, { kind: 'advisories', label: 'advisories' }, { kind: 'install', label: 'install in a box' }];

/** The branch's whole graph: each step of its body, done, working or still to come, and the evidence side by side. */
function wmBranchView(state: WmState, branch: WmBranch): Node {
  const labels = state.plan?.steps ?? WM_CALLS.map((call) => call.label);
  let reached = false;
  const steps = labels.map((label, index) => {
    const done = state.plan ? wmFinished(state, branch) || pathStatus(state.status, wmStepPath(branch.id, index)) === 'done' : branch.calls[WM_CALLS[index]?.kind ?? 'registry'] === 'done';
    const status = done ? 'done' : !reached && branch.seen && !wmFinished(state, branch) ? 'working' : 'pending';
    if (!done) reached = true;
    return h('span', { class: `wm-node ${status}`, title: wmStepPath(branch.id, index) }, label);
  });
  const install = branch.facts.install;
  const registry = branch.facts.registry;
  const advisories = branch.facts.advisories;
  const repository = branch.repository;
  const page = (path: string, url: string): Node => {
    const blob = state.evidence[path];
    return h('li', {}, blob ? ({ tag: 'a', blob, text: url || path } as Node) : url || path);
  };
  const notes = [
    registry?.deprecated ? `Deprecated: ${registry.deprecated}` : '',
    ...(advisories?.advisories ?? []).map((id) => `Advisory ${id}${advisories?.summaries?.[id] ? `: ${advisories.summaries[id]}` : ''}`),
  ].filter(Boolean);
  return h('div', { class: 'wm-branch', path: branch.id },
    h('h4', {}, `${wmName(state, branch)}${branch.verdict ? ` · verdict ${branch.verdict.answer}${branch.verdict.confidence === null ? '' : ` (${Math.round(branch.verdict.confidence * 100)}%)`}` : ''}`),
    h('div', { class: 'wm-graph' }, ...steps),
    h('div', { class: 'wm-evidence' },
      h('section', { class: 'wm-box' },
        h('h5', {}, 'The box\'s network log'),
        install === undefined ? h('p', { class: 'empty' }, 'Not run yet.')
          : install.ran === false ? h('p', { class: 'empty' }, install.note ?? 'The install did not run in a box in this recording.')
          : h('div', {},
            h('ul', {}, ...wmConnections(install).map((connection) => h('li', { class: connection.outside ? 'outside' : '' }, connection.text)),
              ...(install.scripts?.length ? [h('li', {}, `install scripts: ${install.scripts.join(', ')}`)] : [])),
            install.logTail ? h('pre', { class: 'wm-log' }, wmTail(install.logTail)) : false)),
      h('section', { class: 'wm-page' },
        h('h5', {}, 'The repository page'),
        repository === undefined ? h('p', { class: 'empty' }, 'No page read yet.')
          : h('div', {}, repository.archived ? h('p', {}, `Archived: ${repository.archived}`) : false,
            repository.pages.length ? h('ul', {}, ...repository.pages.map((each) => page(each.path, each.url))) : h('p', { class: 'empty' }, 'No page was read.'))),
      h('section', { class: 'wm-vision' },
        h('h5', {}, 'The badge, as vision read it'),
        branch.vision.length ? h('div', {}, ...branch.vision.map((look) => h('div', { class: 'wm-look' },
          look.blob ? ({ tag: 'img', blob: look.blob, alt: 'the image vision looked at', class: 'wm-shot' } as Node) : '',
          h('p', look.text === '' ? { class: 'empty' } : {}, look.text === '' ? 'The eyes returned no text.' : look.text),
          state.evidence[look.receipt] ? ({ tag: 'a', blob: state.evidence[look.receipt]!, text: 'the look\'s receipt' } as Node) : false)))
          : repository?.badges.length ? h('ul', {}, ...repository.badges.map((badge) => h('li', {}, badge)))
          : h('p', { class: 'empty' }, 'No badge read.'))),
    notes.length > 0 && h('ul', { class: 'wm-notes' }, ...notes.map((note) => h('li', {}, note))),
    branch.findings.length > 0 && h('ul', { class: 'wm-facts' }, ...branch.findings.map((fact) => h('li', {}, fact.claim, fact.source ? ` — ${fact.source}` : ''))));
}

/** The connections the install made: what the box's strace saw (host, address, port) when the receipt carries it, else the hosts it names; each flagged
 *  when it is not the package registry. */
function wmConnections(install: CallFacts): { text: string; outside: boolean }[] {
  const outside = new Set(install.outside ?? []);
  if (install.outbound?.length) {
    return install.outbound.map((each) => ({ text: `${each.host ?? each.ip}${each.host ? ` (${each.ip}${each.port !== undefined ? `:${each.port}` : ''})` : each.port !== undefined ? `:${each.port}` : ''}${outside.has(each.host ?? each.ip) ? ' (not the registry)' : ''}`,
      outside: outside.has(each.host ?? each.ip) }));
  }
  return (install.hosts ?? []).map((host) => ({ text: outside.has(host) ? `${host} (not the registry)` : host, outside: outside.has(host) }));
}

/** The last lines of an install's log. */
const wmTail = (log: string) => log.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-5).join('\n');

/** The price of chaos: the baseline recording's own counters against this run's. */
function wmLedger(state: WmState, base: BaselineView, providers: 'real' | 'scripted' | undefined): Node {
  const mine = countersOf(state.counters, true);
  const money = (usd: number | null) => (usd === null ? 'unknown' : `$${usd.toFixed(2)}`);
  const seconds = (ms: number | null) => (ms === null ? 'unknown' : `${(ms / 1000).toFixed(0)} s`);
  const row = (label: string, without: string, withKills: string, alarm = false) => h('tr', { class: alarm ? 'alarm' : '' }, h('th', {}, label), h('td', {}, without), h('td', {}, withKills));
  // The price of the kills is a difference of two costs, so it is computed only when both runs priced real providers (draft 18): a scripted run
  // priced nothing, and a number against it would be a comparison of a replay with a paid run. A missing field on either side reads the same.
  const comparable = providers === 'real' && base.providers === 'real';
  const delta = !comparable ? `not comparable (run: ${providers ?? 'not recorded'}, baseline: ${base.providers ?? 'not recorded'}; the price needs both real)`
    : base.counters.cost !== null && mine.cost !== null ? `${mine.cost - base.counters.cost >= 0 ? '+' : '-'}$${Math.abs(mine.cost - base.counters.cost).toFixed(2)}` : 'unknown';
  return h('div', { class: 'wm-ledger' },
    h('h4', {}, `The price of chaos: ${base.label} against ${state.kills.length} kills`),
    h('table', {},
      h('tr', {}, h('th', {}, ''), h('th', {}, base.label), h('th', {}, `${state.kills.length} kills`)),
      row('cost', money(base.counters.cost), money(mine.cost)),
      row('paid calls made', String(base.counters.paid.total), String(mine.paid.total)),
      row('paid calls repeated', repeatedLabel(base.counters), repeatedLabel(mine), mine.repeated > 0),
      row('model turns committed', String(base.counters.modelTurns.committed), String(mine.modelTurns.committed)),
      row('wall time', seconds(base.ms), seconds(state.finishedAt ?? null))),
    h('p', { class: 'wm-price' }, `Price of the kills: ${delta}${comparable ? '.' : ''}`));
}

register(workflowMapPanel);
