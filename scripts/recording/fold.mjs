// The counters of agentrun.recording/1 section 6 that can be folded from a recording's durable lines, plus the processes and
// kills the supervisor wrote. Nothing here reads a live line to count: a live line only shows what is in flight.
//
// `node scripts/recording/fold.mjs <recording-dir>` prints them as JSON.
import { readFileSync } from 'node:fs';
import { gatewayIntentOf } from '@parcha/agentrun-dsl/recovery';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entryOf = line => (Array.isArray(line.data?.model) ? line.data.model[0] : undefined);

const aborted = event => event.data?.model?.[0]?.stopReason === 'aborted';

/** The pi.live document version this fold reads. On any other version the re-asked fold is NOT MEASURED, never guessed. */
export const PI_LIVE_VERSION = 1;

/** Re-asked model turns, from the durable `pi.live` lines (section 6). pi commits the start of every ask: a `pi.live` revision in which
 *  `generation` appears without a `message` (written at the generation task's request phase, before the model is called), and a throttled
 *  partial after it. An ask's position is (conversation, the non-aborted assistant entries committed before it); a committed partial
 *  becomes an assistant entry with stopReason `aborted` when the next ask starts, and is not a committed turn.
 *  - PROVEN: a position asked more than once, each ask shown by a revision of its own (an ask whose partial was committed leaves one when
 *    the next ask starts). `turns`: such positions; `asks`: their asks, summed.
 *  - POSSIBLE: a position where an ask was cut with only its start marker (a snapshot at open shows the marker still open) and a later
 *    process committed the turn: that process's ask rewrote the same value, which pi stores as no new revision, so it shows only as its
 *    first partial or its entry. `turns`: such positions.
 *  A snapshot that carries a stale `generation` is the ask already open at that position, or one more ask by an earlier generation when its
 *  start line died in flight. `null` (not measured) when no ask start was ever committed, or when a `pi.live` line is of a version this fold
 *  does not know. */
export function reAsked(events) {
  const state = new Map();
  const asksAt = new Map();
  const cutAt = new Set();
  const committedAt = new Set();
  let known = true;
  let starts = 0;
  const of = conv => { if (!state.has(conv)) state.set(conv, { committed: 0, open: undefined, generation: undefined }); return state.get(conv); };
  const ask = (conv, held) => { const key = `${conv}\u0001${held.committed}`; asksAt.set(key, (asksAt.get(key) ?? 0) + 1); held.open = held.committed; starts += 1; };
  for (const event of events) {
    if (event.channel !== 'durable') continue;
    const conv = event.conv ?? 0;
    if (event.kind === 'pi.live' && event.data?.version !== undefined && event.data.version !== PI_LIVE_VERSION) known = false;
    if (event.kind === 'pi.assistant' && !event.snapshot) {
      if (!aborted(event)) { const held = of(conv); committedAt.add(`${conv}\u0001${held.committed}`); held.committed += 1; held.open = undefined; }
      continue;
    }
    if (event.kind !== 'pi.live') continue;
    const held = of(conv);
    const generation = event.data?.value?.generation;
    if (event.snapshot) {
      // State, not an event: the ask already open at this position is the same ask; otherwise its start line died in flight.
      if (generation !== undefined && held.open !== held.committed) ask(conv, held);
      // A marker-only ask cut by a process death, seen at the next process's open.
      if (generation !== undefined && generation.message === undefined) cutAt.add(`${conv}\u0001${held.committed}`);
      held.generation = generation;
      continue;
    }
    const appears = generation !== undefined && generation.message === undefined
      && (held.generation === undefined || held.generation.message !== undefined || held.generation.attempt !== generation.attempt);
    if (appears) ask(conv, held);
    held.generation = generation;
  }
  if (!known || starts === 0) return null;
  const proven = [...asksAt].filter(([, count]) => count > 1);
  const possible = [...cutAt].filter(key => (asksAt.get(key) ?? 0) <= 1 && committedAt.has(key));
  return { proven: { turns: proven.length, asks: proven.reduce((sum, [, count]) => sum + count, 0) }, possible: { turns: possible.length } };
}

/** `repeated` and `asked twice` (section 6), each scoped to ONE call and never across calls. Snapshot lines are state, not events, and are
 *  skipped; a lost branch is events and is folded.
 *  - A workflow effect: an effect id with an APPLIED call (its `calls` record, `outcome: 'applied'`) in a later generation than an
 *    earlier applied one is repeated; two applied calls in one generation are asked twice. An effect with no `calls` record is not
 *    measured: the result is null, never 0. Two effect ids with one intent are two calls.
 *  - An agent's tool call counts only when it is PAID: the run holds an `agentrun.receipts` entry for its (tool, argsHash). That
 *    receipt key is its identity, run-wide. A paid execution (not reused, not refused) of one key in a later generation than one that
 *    completed is repeated; a second one within one generation is asked twice. A tool with no receipt never counts. */
export function repeats(events) {
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
        const extends_ = records.length >= held.list.length && held.list.every((call, at) => JSON.stringify(call) === JSON.stringify(records[at]));
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
  const payments = lists => {
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
export function fold(events) {
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
  const values = doc => [...latest].filter(([id]) => id.startsWith(`${doc}\u0001`)).map(([, value]) => value);
  const effects = values('agentrun.effects');
  const receipts = values('agentrun.receipts').filter(receipt => typeof receipt?.tool === 'string' && receipt.tool !== '');
  const decisions = values('agentrun.decisions').flatMap(value => value.receipts ?? []);
  // Cost: the usage and priced parts of the run, null when any part is unknown (a judge row whose cost the host did not report).
  const parts = {};
  const add = (name, amount) => { parts[name] = parts[name] === null || amount === null ? null : (parts[name] ?? 0) + amount; };
  for (const usage of values('pi.usage')) for (const group of [usage.models, usage.tools]) for (const [name, used] of Object.entries(group ?? {})) add(name, typeof used?.cost?.total === 'number' ? used.cost.total : null);
  if (decisions.length) for (const receipt of decisions) add('judge', typeof receipt.cost_usd === 'number' ? receipt.cost_usd : null);
  const cost = { usd: Object.values(parts).some(part => part === null) ? null : Object.values(parts).reduce((sum, part) => sum + part, 0), parts };
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
    modelTurnsCommitted: assistantEntries,
    cost,
    reAsked: reAsked(events),
    ...repeats(events),
  };
}

export const readEvents = dir => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node scripts/recording/fold.mjs <recording-dir>'); process.exit(2); }
  console.log(JSON.stringify(fold(readEvents(process.argv[2])), null, 2));
}
