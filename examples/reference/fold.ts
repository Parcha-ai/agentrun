// The counters of agentrun.recording/1 section 6 that can be folded from a recording's durable lines, plus the processes and
// kills the supervisor wrote. Nothing here reads a live line to count: a live line only shows what is in flight.
//
// `node scripts/recording/fold.mjs <recording-dir>` prints them as JSON. This file stands alone (the example is copied without
// `scripts/`): it imports only node and the packages.
import { readFileSync } from 'node:fs';
import { gatewayIntentOf } from '@parcha/agentrun-dsl/recovery';
import { join } from 'node:path';

/** One line of a recording's `events.jsonl`, as parsed. */
export type Line = Record<string, any>;
export type Cost = { usd: number | null; parts: Record<string, number | null> };
export type Reasks = { turns: number; reasks: number };
export type ReAsked = { proven: Reasks; possible: Reasks };

const entryOf = (line: Line) => (Array.isArray(line.data?.model) ? line.data.model[0] : undefined);

const aborted = (event: Line) => event.data?.model?.[0]?.stopReason === 'aborted';

/** The pi.live document version this fold reads. On any other version the re-asked fold is NOT MEASURED, never guessed. */
export const PI_LIVE_VERSION = 1;

/** Re-asked model turns, from the durable `pi.live` lines (section 6). pi commits `generation` without a `message` at the generation task's
 *  request phase, BEFORE it calls the model, converting any cut partial and setting a bare marker in one commit, then a throttled partial
 *  `message` as the answer streams. An ask's position is (conversation, the non-aborted assistant entries committed before it). The fold does
 *  not depend on pi appending an aborted entry for a cut partial, and it never classifies a cut ask from snapshots alone: a snapshot can show
 *  a cut ask's marker bare after pi drops its partial, so the proof is in each process's own non-snapshot lines.
 *
 *  At one position, in order: a bare marker after a partial is a NEW ask (it never un-proves the old one); a partial a different process
 *  commits than the one that wrote the open marker is a new ask; a partial of another timestamp than the open ask's is a new ask (the
 *  timestamp is the ask's identity, the same in every partial it commits and in the entry it finally commits); a snapshot that carries a
 *  generation where none is open is an ask an earlier process's start line died on; a snapshot where one is open is that ask. The last ask
 *  answered (or is in flight); every other ask was CUT by a process death, and counts once. A cut ask that committed a partial is PROVEN (the
 *  model was answering); a cut ask with only its start marker is POSSIBLE (the process may have died between that commit and the model call),
 *  and a bare marker that stays unchanged across several opens is ONE, because no process that may have asked under it leaves a line.
 *  Returns the re-asks (asks at a position minus one) split proven and possible, and the positions that have them. `null` (not measured) when
 *  no ask start was ever committed, or when a `pi.live` line is of a version this fold does not know. */
type Ask = { ts: unknown; owner: number };
type Position = { asks: Ask[]; cur: Ask | undefined };

export function reAsked(events: readonly Line[]): ReAsked | null {
  const committed = new Map();
  const positions = new Map();
  let process = 0;
  let known = true;
  let starts = 0;
  const at = (key: string): Position => { if (!positions.has(key)) positions.set(key, { asks: [], cur: undefined }); return positions.get(key)!; };
  const open = (held: Position, ts: unknown, owner: number) => { const ask = { ts, owner }; held.asks.push(ask); held.cur = ask; };
  for (const event of events) {
    if (event.source === 'host' && event.kind === 'process.started') process += 1;
    if (event.channel !== 'durable') continue;
    const conv = event.conv ?? 0;
    if (event.kind === 'pi.live' && event.data?.version !== undefined && event.data.version !== PI_LIVE_VERSION) known = false;
    if (event.kind === 'pi.assistant' && !event.snapshot) {
      if (aborted(event)) continue;
      const held = at(`${conv}\u0001${committed.get(conv) ?? 0}`);
      const ts = event.data?.model?.[0]?.timestamp;
      const cur = held.cur;
      // The entry answers the open ask when it is that ask's (same timestamp, or the ask wrote only a marker in this process); otherwise it
      // was answered by an ask that left no line of its own.
      if (cur === undefined || (cur.ts !== undefined && cur.ts !== ts) || (cur.ts === undefined && cur.owner !== process)) open(held, ts, process);
      held.cur = undefined;
      committed.set(conv, (committed.get(conv) ?? 0) + 1);
      continue;
    }
    if (event.kind !== 'pi.live') continue;
    const generation = event.data?.value?.generation;
    if (generation === undefined) continue;
    starts += 1;
    const held = at(`${conv}\u0001${committed.get(conv) ?? 0}`);
    const ts = generation.message === undefined ? undefined : generation.message.timestamp ?? JSON.stringify(generation.message);
    if (event.snapshot) {
      if (held.cur === undefined) open(held, ts, process - 1);
      else if (ts !== undefined && held.cur.ts === undefined) held.cur.ts = ts;
    } else if (ts === undefined) open(held, undefined, process);
    else if (held.cur === undefined || (held.cur.ts !== undefined && held.cur.ts !== ts) || (held.cur.ts === undefined && held.cur.owner !== process)) open(held, ts, process);
    else held.cur.ts = ts;
  }
  if (!known || starts === 0) return null;
  const count = (has: (ask: Ask) => boolean): Reasks => { let turns = 0; let reasks = 0; for (const held of positions.values()) { const n = held.asks.slice(0, -1).filter((ask: Ask) => has(ask)).length; if (n > 0) { turns += 1; reasks += n; } } return { turns, reasks }; };
  return { proven: count(ask => ask.ts !== undefined), possible: count(ask => ask.ts === undefined) };
}

/** `repeated` and `asked twice` (section 6), each scoped to ONE call and never across calls. Snapshot lines are state, not events, and are
 *  skipped; a lost branch is events and is folded.
 *  - A workflow effect: an effect id with an APPLIED call (its `calls` record, `outcome: 'applied'`) in a later generation than an
 *    earlier applied one is repeated; two applied calls in one generation are asked twice. An effect with no `calls` record is not
 *    measured: the result is null, never 0. Two effect ids with one intent are two calls.
 *  - An agent's tool call counts only when it is PAID: the run holds an `agentrun.receipts` entry for its (tool, argsHash). That
 *    receipt key is its identity, run-wide. A paid execution (not reused, not refused) of one key in a later generation than one that
 *    completed is repeated; a second one within one generation is asked twice. A tool with no receipt never counts. */
export function repeats(events: readonly Line[]): { repeated: { effects: number | null; agentToolCalls: number }; askedTwice: number } {
  const applied = new Map();
  let measured = true;
  let effectsSeen = 0;
  const calls = new Map();
  const executed = new Map();
  const receipts = new Set();
  for (const event of events) {
    if (event.channel === 'durable' && event.data?.doc === 'agentrun.receipts' && typeof event.data.value?.tool === 'string' && typeof event.data.value?.argsHash === 'string') receipts.add(`${event.data.value.tool}:${event.data.value.argsHash}`);
  }
  for (const event of events) {
    if (event.channel !== 'durable') continue;
    if (event.data?.doc === 'agentrun.effects' && event.data.value) {
      // An effect's calls list is append-only and every line carries the whole list. Walk the effect's lines in order, snapshots included,
      // and take from each only the calls beyond the previous line's list. A line gives its new calls its own generation; a snapshot gives
      // them an EARLIER one (they were committed before its process opened and their own lines were lost in flight). A list that does not
      // extend the previous one (a restore's snapshot, 3.2) becomes the new base; a lost branch's calls stay counted where first seen.
      const id = event.data.key ?? '';
      const records = Array.isArray(event.data.value.calls) ? event.data.value.calls : undefined;
      if (!applied.has(id)) { applied.set(id, { gens: [], list: [], hasCalls: false }); effectsSeen += 1; }
      const held = applied.get(id);
      if (records) {
        held.hasCalls = true;
        const extends_ = records.length >= held.list.length && held.list.every((call: unknown, at: number) => JSON.stringify(call) === JSON.stringify(records[at]));
        if (extends_) {
          // A snapshot's gen is an earlier process's (3.1): the calls it newly shows were committed before its process opened.
          const placed = event.gen ?? 0;
          for (const call of records.slice(held.list.length)) if (call?.outcome === 'applied') held.gens.push(placed);
        }
        held.list = records;
      }
    }
    if (event.snapshot) continue;
    const entry = entryOf(event);
    if (event.kind === 'pi.assistant' && entry?.content) for (const part of entry.content) if (part.type === 'toolCall') { const { tool, argsHash } = gatewayIntentOf(part.name, part.arguments); calls.set(part.id, `${tool}:${argsHash}`); }
    if (event.kind === 'pi.tool-result' && entry?.role === 'toolResult' && entry.details?.refused !== true && entry.details?.effect_status !== 'reused') {
      const key = calls.get(entry.toolCallId);
      if (key === undefined || !receipts.has(key)) continue;
      const gens = executed.get(key) ?? [];
      gens.push(event.gen ?? 0);
      executed.set(key, gens);
    }
  }
  // Measured only when every effect reported its calls; without them the strip shows 'not measured', never 0.
  measured = effectsSeen > 0 && [...applied.values()].every(held => held.hasCalls);
  // Each extra payment (an applied call, or a paid execution, after the first of its id or key) counts once: in repeated when its generation
  // is later than the previous one's, in asked twice when it is the same.
  const payments = (lists: number[][]) => {
    let later = 0;
    let same = 0;
    for (const gens of lists) for (let at = 1; at < gens.length; at += 1) { if (gens[at] > gens[at - 1]) later += 1; else if (gens[at] === gens[at - 1]) same += 1; }
    return { later, same };
  };
  const byEffect = payments([...applied.values()].map(held => held.gens));
  const byKey = payments([...executed.values()]);
  const effectRepeats = measured ? byEffect.later : null;
  const toolRepeats = byKey.later;
  const askedTwice = byKey.same + (measured ? byEffect.same : 0);
  return { repeated: { effects: effectRepeats, agentToolCalls: toolRepeats }, askedTwice };
}

/** The counters folded from the recording's lines (an array of parsed lines). */
export function fold(events: readonly Line[]) {
  const latest = new Map();
  let processes = 0;
  let kills = 0;
  let assistantEntries = 0;
  for (const event of events) {
    if (event.source === 'host' && event.kind === 'process.started') processes += 1;
    if (event.source === 'host' && event.kind === 'kill') kills += 1;
    if (event.channel !== 'durable') continue;
    if (!event.snapshot && event.kind === 'pi.assistant' && !aborted(event)) assistantEntries += 1;
    const { doc, key } = event.data ?? {};
    if (typeof doc === 'string' && event.data.value !== undefined) latest.set(`${doc}\u0001${key ?? ''}\u0001${event.conv ?? ''}`, event.data.value);
  }
  const values = (doc: string): Line[] => [...latest].filter(([id]) => id.startsWith(`${doc}\u0001`)).map(([, value]) => value);
  const effects = values('agentrun.effects');
  const receipts = values('agentrun.receipts').filter(receipt => typeof receipt?.tool === 'string' && receipt.tool !== '');
  const decisions = values('agentrun.decisions').flatMap(value => value.receipts ?? []);
  // Cost: the usage and priced parts of the run, null when any part is unknown (a judge row whose cost the host did not report).
  const parts: Record<string, number | null> = {};
  const add = (name: string, amount: number | null) => { parts[name] = parts[name] === null || amount === null ? null : (parts[name] ?? 0) + amount; };
  for (const usage of values('pi.usage')) for (const group of [usage.models, usage.tools]) for (const [name, used] of Object.entries((group ?? {}) as Record<string, Line>)) add(name, typeof used?.cost?.total === 'number' ? used.cost.total : null);
  if (decisions.length) for (const receipt of decisions) add('judge', typeof receipt.cost_usd === 'number' ? receipt.cost_usd : null);
  const cost: Cost = { usd: Object.values(parts).some(part => part === null) ? null : Object.values(parts).reduce<number>((sum, part) => sum + (part as number), 0), parts };
  return {
    processes,
    kills,
    // Workflow effects that reached `completed`: once per id, since the latest value per (doc, key) is the id's last state.
    // Paid calls made, summed per source (section 6): workflow effects that reached `completed`, plus the agent's paid tool calls (one
    // `agentrun.receipts` entry per tool and argsHash). The browser's, vision's and transport's own rows are not in a recording yet.
    paidCallsMade: effects.filter(effect => effect.status === 'completed').length + receipts.length,
    // Effects still `unknown` at the end of the run.
    unknown: effects.filter(effect => effect.status === 'unknown').length,
    judgeAsks: { answered: decisions.filter(receipt => !receipt.error).length, failed: decisions.filter(receipt => receipt.error).length },
    modelTurns: { committed: assistantEntries, reasked: reAsked(events) },
    cost,
    ...repeats(events),
  };
}

export const readEvents = (dir: string): Line[] => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
