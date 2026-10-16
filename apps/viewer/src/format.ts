// agentrun.recording/1 (RECORDING.md): the types, the line order, and the validator of section 3's invariants.
import { docOf, generationOf, moveOf, type Move } from './durable.ts';
import { counterFold, countersOf } from './counters.ts';

export const FORMAT = 'agentrun.recording/1';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Source = 'workflow' | 'pi' | 'browser' | 'vision' | 'transport' | 'host';

export type Line = {
  channel: 'durable' | 'live';
  source: Source;
  kind: string;
  /** Live: the process that wrote it. Durable: the journal opens before its commit, absent before the first. */
  gen?: number;
  t: number;
  commit?: number;
  order?: number;
  seq?: number;
  path?: string;
  conv?: number;
  /** Durable only: the pi task a task-scoped document belongs to. */
  task?: string;
  data: Json;
  blobs?: string[];
  /** A copy of a document's value taken when a process opened the run: it replaces the value per (doc, key), and is
   *  outside the commits' strict order. */
  snapshot?: boolean;
};

export type Manifest = {
  format: string;
  title: string;
  task: string;
  recorded: { started: string; ended: string };
  code: { repo: string; commit: string; packages: Record<string, string> };
  model: string;
  generations: number;
  kills: number;
  /** `scripted` when any priced part of the run came from a cassette, a script or a fake; `real` when every one was a real provider's. */
  providers?: 'real' | 'scripted';
  cost: { usd: number | null; parts: Record<string, number | null> };
  source: { run: string; store_sha256: string };
  result?: { blob: string; title: string };
  /** The job that ran (`{ workflow, input, files }`), as a JSON blob (draft 24). */
  job?: { blob: string; sha256: string };
  /** The run's store at its end, a SQLite blob, and the commit of the generation it was taken at (draft 24). */
  store?: { blob: string; at: { gen: number; commit: number } };
  /** Jump points: the screen just after that commit of that generation (a restore reuses commit numbers). */
  chapters?: { title: string; at: { gen: number; commit: number }; focus?: string }[];
  /** Another real recording (a relative path or URL) whose counters show beside this one's. */
  baseline?: { recording: string; label: string };
};

/** A recording as the viewer holds it: its manifest, its lines in file order, and where a blob's bytes are. */
export type Recording = { id: string; manifest: Manifest; lines: Line[]; blobUrl(sha: string): string | undefined; blobType(sha: string): string | undefined };

const SOURCES = new Set(['workflow', 'pi', 'browser', 'vision', 'transport', 'host']);
const isInt = (value: unknown, min = 0) => Number.isInteger(value) && (value as number) >= min;

/** The supervisor's lines: every live `host` line (`process.started`, `kill`, `result`), written outside the run's
 *  processes, with no event-level gen and their own seq. */
export const isSupervisor = (line: Line) => line.channel === 'live' && line.source === 'host';
/** The supervisor's line kinds whose fields name the process they are about (`data.gen`, RECORDING.md section 5's host
 *  row). The others name none (a `picture`, a `box.receipt`), and a kind this viewer does not know is not checked for it. */
export const GEN_HOST_KINDS: ReadonlySet<string> = new Set(['process.started', 'kill', 'result', 'kill.failed', 'kill.request.ignored', 'signals.failed',
  'recording.carry.failed', 'run.json', 'delegation', 'revoke', 'fenced']);
/** The process a supervisor line is about, from its data (an earlier recording put it on the line). */
export const processOf = (line: Line): number | undefined => {
  const gen = (line.data as { gen?: unknown } | null)?.gen;
  return typeof gen === 'number' ? gen : line.gen;
};

/** The process each line belongs to: the supervisor's `process.started` lines before it (0 before the first). */
export const processesOf = (lines: Line[]): number[] => {
  let process = 0;
  return lines.map((line) => (isSupervisor(line) && line.kind === 'process.started' ? (process += 1) : process));
};

/** Where a restore starts again (RECORDING.md 3.2): a process's snapshot (the snapshot lines it writes at its open,
 *  after its `process.started`; a run of them when a recording has no supervisor lines) whose commit is below one
 *  already seen. The map is from its first line's index to its commit, the checkpoint's last commit. */
export function restoresOf(lines: Line[]): Map<number, number> {
  const restores = new Map<number, number>();
  let highest = -1;
  let inSnapshot = false;
  let opened = false;
  lines.forEach((line, index) => {
    if (isSupervisor(line) && line.kind === 'process.started') opened = true;
    if (line.channel !== 'durable' || line.commit === undefined) return;
    const first = line.snapshot === true && (opened || !inSnapshot);
    inSnapshot = line.snapshot === true;
    if (line.snapshot === true) opened = false;
    if (first && line.commit < highest) { restores.set(index, line.commit); highest = line.commit; return; }
    highest = Math.max(highest, line.commit);
  });
  return restores;
}

/** `events.jsonl`'s lines, in file order. */
export function parseLines(text: string): Line[] {
  return text.split('\n').filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) as Line; } catch { throw new Error(`events.jsonl line ${index + 1} does not parse`); }
  });
}

/** What breaks the format in a recording, at most `limit` problems; empty when it obeys sections 2 and 3. */
export function validate(manifest: unknown, lines: Line[], blobs?: Set<string>, limit = 20): string[] {
  const problems: string[] = [];
  const note = (problem: string) => { if (problems.length < limit) problems.push(problem); };
  const m = manifest as Partial<Manifest> | null;
  if (!m || m.format !== FORMAT) note(`manifest.format is not ${FORMAT}`);
  if (typeof m?.title !== 'string') note('manifest.title is missing');
  if (!isInt(m?.generations, 1)) note('manifest.generations is not a whole number from 1');
  if (!isInt(m?.kills)) note('manifest.kills is not a whole number');
  if (m?.providers !== undefined && m.providers !== 'real' && m.providers !== 'scripted') note('manifest.providers is not real or scripted');
  const parts = Object.values(m?.cost?.parts ?? {});
  if (m?.cost && parts.some((part) => part === null) && m.cost.usd !== null) note('manifest.cost.usd is a number though a part is unknown');
  if (m?.result && blobs && !blobs.has(m.result.blob)) note(`manifest.result.blob ${m.result.blob} is not in blobs/`);
  const sha256 = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (m?.job !== undefined && !(sha256(m.job?.blob) && sha256(m.job?.sha256))) note('manifest.job is not { blob, sha256 }');
  if (m?.store !== undefined && !(sha256(m.store?.blob) && count(m.store?.at?.gen) && count(m.store?.at?.commit))) note('manifest.store is not { blob, at: { gen, commit } }');
  for (const [field, named] of [['job', m?.job], ['store', m?.store]] as const) {
    if (named && sha256(named.blob) && blobs && !blobs.has(named.blob)) note(`manifest.${field}.blob ${named.blob} is not in blobs/`);
  }
  if (m?.chapters !== undefined && !(Array.isArray(m.chapters) && m.chapters.every((chapter) => typeof chapter?.title === 'string'
    && isInt(chapter.at?.gen, 1) && isInt(chapter.at?.commit) && (chapter.focus === undefined || typeof chapter.focus === 'string')))) note('manifest.chapters needs a title and at { gen, commit } in each');
  else for (const chapter of m?.chapters ?? []) {
    if (!lines.some((line) => line.channel === 'durable' && line.gen === chapter.at.gen && line.commit === chapter.at.commit)) note(`manifest chapter "${chapter.title}" is at commit ${chapter.at.commit} of generation ${chapter.at.gen}, which no durable line holds`);
  }
  if (m?.baseline !== undefined && !(typeof m.baseline?.recording === 'string' && typeof m.baseline.label === 'string')) note('manifest.baseline needs recording and label');
  // The manifest's cost is section 6's fold of the lines: null when any part is unknown.
  if (m?.cost && (m.cost.usd === null || typeof m.cost.usd === 'number')) {
    const folded = countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true).cost;
    if (folded === null ? m.cost.usd !== null : m.cost.usd === null || Math.abs(m.cost.usd - folded) > 1e-9) note(`manifest.cost.usd is ${m.cost.usd}, but the lines fold to ${folded === null ? 'null (a part is unknown)' : folded}`);
  }

  // 3.2 goes by process. A restore is accepted only with its restore record, naming the checkpoint's head: that
  // process's line after its snapshot (whose gen is an earlier process's). Every move record carries `head`, the target's
  // first new commit: its process's first non-snapshot commit equals it, and the record's own commit is at or above it.
  // A restore's process may also start at head + 1 when pi committed once at open (draft 37): its own snapshot is then at
  // commit head, so that commit's state is in it. A move continues the sequence (its head is one above the last commit
  // seen and equals seal.head); a restore's head is replayed.to + 1 when it replayed, else checkpoint.head.
  const restores = restoresOf(lines);
  const processAt = processesOf(lines);
  const restoreHeads = new Map<number, number[]>();
  const dropAt = [...restores.keys()];
  const dropOf = (index: number) => dropAt.findLast((at) => at < index && processAt[at] === processAt[index]);
  const moves: { at: string; process: number; commit: number; move: Move }[] = [];
  const seenBefore = new Map<number, number>();
  const firstNew = new Map<number, number>();
  const snapshotOf = new Map<number, number>();
  let seen = -1;
  lines.forEach((line, index) => {
    if (line.channel !== 'durable' || !isInt(line.commit)) return;
    if (restores.has(index)) seen = line.commit!;
    const process = processAt[index]!;
    if (line.snapshot === true && !snapshotOf.has(process)) snapshotOf.set(process, line.commit!);
    if (line.snapshot !== true && !firstNew.has(process)) { seenBefore.set(process, seen); firstNew.set(process, line.commit!); }
    seen = Math.max(seen, line.commit!);
    // A snapshot carries earlier moves' records as state: only a record a process writes is its own move.
    const doc = line.snapshot === true ? undefined : docOf(line);
    const move = doc ? moveOf(doc) : undefined;
    if (!move) return;
    moves.push({ at: `line ${index + 1}`, process, commit: line.commit!, move });
    const drop = dropOf(index);
    if (move.kind === 'restore' && move.head !== undefined && drop !== undefined) restoreHeads.set(drop, [...(restoreHeads.get(drop) ?? []), move.head]);
  });
  for (const { at, process, commit, move } of moves) {
    if (move.head === undefined) { note(`${at}: a transport.moves record has no head`); continue; }
    const first = firstNew.get(process);
    const atOpen = move.kind === 'restore' && first === move.head + 1 && snapshotOf.get(process) === move.head;
    if (first !== move.head && !atOpen) note(`${at}: the ${move.kind}'s head ${move.head} is not process ${process}'s first new commit ${first}`);
    if (commit < move.head) note(`${at}: the ${move.kind} record is at commit ${commit}, below its head ${move.head}`);
    if (move.kind === 'move') {
      if (move.seal !== undefined && move.seal !== move.head) note(`${at}: a move's head ${move.head} is not its seal.head ${move.seal}`);
      const before = seenBefore.get(process);
      if (before !== undefined && move.head !== before + 1) note(`${at}: a move's head ${move.head} is not one above commit ${before}, the last before process ${process}`);
    }
    if (move.kind === 'restore') {
      const wanted = move.replayedTo !== undefined ? move.replayedTo + 1 : move.checkpoint;
      if (wanted !== undefined && move.head !== wanted) note(`${at}: a restore's head ${move.head} is not ${move.replayedTo !== undefined ? 'replayed.to + 1' : 'its checkpoint.head'} ${wanted}`);
    }
  }

  // A snapshot's gen is the driver's at its commit (3.1), which its own `agentrun.driver` document states.
  const snapshotGen = new Map<number, number>();
  {
    let first = -1;
    restoresOf(lines);
    let inSnapshot = false;
    let opened = false;
    lines.forEach((line, index) => {
      if (isSupervisor(line) && line.kind === 'process.started') opened = true;
      if (line.channel !== 'durable') return;
      if (line.snapshot === true && (opened || !inSnapshot)) first = index;
      inSnapshot = line.snapshot === true;
      if (line.snapshot === true) opened = false;
      const doc = line.snapshot === true ? docOf(line) : undefined;
      const driver = doc ? generationOf(doc) : undefined;
      if (driver !== undefined) snapshotGen.set(first, driver);
    });
    let runFirst = -1;
    inSnapshot = false;
    opened = false;
    lines.forEach((line, index) => {
      if (isSupervisor(line) && line.kind === 'process.started') opened = true;
      if (line.channel !== 'durable') return;
      if (line.snapshot === true && (opened || !inSnapshot)) runFirst = index;
      inSnapshot = line.snapshot === true;
      if (line.snapshot === true) opened = false;
      const driver = line.snapshot === true ? snapshotGen.get(runFirst) : undefined;
      if (driver !== undefined && line.gen !== undefined && line.gen !== driver) note(`line ${index + 1}: a snapshot's gen ${line.gen} is not the driver's at its commit, ${driver}`);
    });
  }

  let last: { commit: number; order: number } | undefined;
  let lastGen: number | undefined;
  let lastT = -Infinity;
  const seqs = new Map<number, number>();
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (line.channel !== 'durable' && line.channel !== 'live') note(`${at}: channel is ${String(line.channel)}`);
    if (!SOURCES.has(line.source)) note(`${at}: source is ${String(line.source)}`);
    if (typeof line.kind !== 'string' || line.kind === '') note(`${at}: no kind`);
    if (isSupervisor(line)) {
      if (line.gen !== undefined) note(`${at}: a supervisor line (${line.kind}) has no event-level gen`);
      if (GEN_HOST_KINDS.has(line.kind) && !isInt((line.data as { gen?: unknown } | null)?.gen, 1)) note(`${at}: a supervisor line (${line.kind}) names its process in data.gen`);
      const crossing = line.kind === 'kill' ? (line.data as { crossing?: { point?: unknown; n?: unknown } | null } | null)?.crossing : null;
      if (crossing !== null && crossing !== undefined && !(typeof crossing.point === 'string' && isInt(crossing.n))) note(`${at}: a kill's crossing is { point, n } or null`);
      const result = line.kind === 'result' ? (line.data as { blob?: unknown; title?: unknown } | null) : undefined;
      if (result !== undefined && !(typeof result?.blob === 'string' && typeof result.title === 'string')) note(`${at}: a result names its blob and title in data`);
    } else if (line.gen !== undefined ? !isInt(line.gen, 1) : line.channel === 'live') note(`${at}: gen is not a whole number from 1`);
    if (line.task !== undefined && (line.channel !== 'durable' || typeof line.task !== 'string')) note(`${at}: task is a durable line's string`);
    if (typeof line.t !== 'number' || !Number.isFinite(line.t)) note(`${at}: t is not a number`);
    else { if (line.t < lastT) note(`${at}: t goes back`); lastT = line.t; }
    if (line.path !== undefined && typeof line.path !== 'string') note(`${at}: path is not a string`);
    if (line.conv !== undefined && !isInt(line.conv)) note(`${at}: conv is not a whole number`);
    for (const sha of line.blobs ?? []) if (blobs && !blobs.has(sha)) note(`${at}: blob ${sha} is not in blobs/`);
    if (line.channel === 'durable') {
      if (!isInt(line.commit) || !isInt(line.order)) { note(`${at}: a durable line needs commit and order`); return; }
      if (line.seq !== undefined) note(`${at}: a durable line has no seq`);
      // A durable gen is the driver's at its commit, a snapshot's included: it never goes back outside a restore.
      if (line.gen !== undefined && !restores.has(index)) {
        if (lastGen !== undefined && line.gen < lastGen) note(`${at}: durable gen ${line.gen} after ${lastGen}`);
        lastGen = Math.max(lastGen ?? line.gen, line.gen);
      }
      const restored = restores.get(index);
      if (restored !== undefined) {
        // The lost branch: the durable rules start again from the restored generation's snapshot.
        // Its head is the commit after the snapshot's, or the snapshot's own when pi committed once at open (draft 37).
        const heads = restoreHeads.get(index) ?? [];
        if (!heads.includes(restored + 1) && !heads.includes(restored)) note(`${at}: the commits go back to ${restored} with no restore record of head ${restored + 1} after it`);
        last = { commit: restored, order: Infinity };
        lastGen = line.gen ?? lastGen;
        return;
      }
      if (line.snapshot === true) {
        if (last && line.commit! < last.commit) note(`${at}: a snapshot below commit ${last.commit}`);
        return;
      }
      if (last && line.commit! < last.commit) note(`${at}: commit ${line.commit} after commit ${last.commit}`);
      else if (last && line.commit === last.commit && line.order! <= last.order) note(`${at}: (commit, order) does not increase`);
      last = { commit: line.commit!, order: line.order! };
    } else if (line.channel === 'live') {
      if (!isInt(line.seq)) { note(`${at}: a live line needs seq`); return; }
      if (line.commit !== undefined || line.order !== undefined) note(`${at}: a live line has no commit or order`);
      const stream = isSupervisor(line) ? 0 : line.gen!;
      const before = seqs.get(stream);
      if (before !== undefined && line.seq! <= before) note(`${at}: seq does not increase ${stream === 0 ? 'across the supervisor\'s lines' : `in process ${line.gen}`}`);
      seqs.set(stream, line.seq!);
    }
  });
  return problems;
}

/** Whether `path` is `focus` or under it, as execution paths nest. */
export const under = (path: string | undefined, focus: string | undefined) =>
  focus === undefined || (path !== undefined && (path === focus || path.startsWith(`${focus}/`)));
