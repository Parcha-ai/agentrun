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

/** Re-asked model turns, from the durable `pi.live` lines (section 6). pi commits `generation` without a `message` at the generation task's
 *  request phase, BEFORE it calls the model, then a throttled partial `message` as the answer streams. An ask's position is (conversation,
 *  the non-aborted assistant entries committed before it). The fold does not depend on pi appending an aborted entry for a cut partial, and
 *  it never classifies a cut ask from snapshots alone: a snapshot can show a cut ask's marker bare after pi drops its partial, so the proof
 *  is in each process's own non-snapshot lines.
 *
 *  An ask that reached the model leaves a partial, and the partial is that ask's: its `timestamp` is the ask's identity, the same in every
 *  partial the ask commits and in the entry it finally commits. At one position the asks that reached the model are the distinct partials
 *  seen (as a line, or carried by a snapshot); the one whose entry was committed answered, and the others were CUT by a process death:
 *  PROVEN re-asks. A process that asked (a snapshot or a start line at the position) and left no partial of its own, and did not answer,
 *  was cut with only its start marker: POSSIBLE, since it may have died between that commit and the model call; consecutive such opens are
 *  ONE possible cut ask, because no process that may have asked under the marker leaves a line.
 *  `proven.turns`: positions with a proven re-ask; `proven.asks`: the proven re-asks, summed. `possible.turns`: positions with a possible one.
 *  `null` (not measured) when no ask start was ever committed, or when a `pi.live` line is of a version this fold does not know. */
export function reAsked(events) {
  const committed = new Map();
  const asked = new Map();
  const answeredBy = new Map();
  const answeredProcess = new Map();
  const askers = new Map();
  const own = new Map();
  let process = 0;
  let known = true;
  let starts = 0;
  const identity = message => message?.timestamp ?? JSON.stringify(message);
  const add = (map, position, value) => map.set(position, new Set([...(map.get(position) ?? []), value]));
  for (const event of events) {
    if (event.source === 'host' && event.kind === 'process.started') process += 1;
    if (event.channel !== 'durable') continue;
    const conv = event.conv ?? 0;
    if (event.kind === 'pi.live' && event.data?.version !== undefined && event.data.version !== PI_LIVE_VERSION) known = false;
    if (event.kind === 'pi.assistant' && !event.snapshot) {
      if (!aborted(event)) {
        const position = `${conv}\u0001${committed.get(conv) ?? 0}`;
        answeredBy.set(position, event.data?.model?.[0]?.timestamp);
        answeredProcess.set(position, process);
        committed.set(conv, (committed.get(conv) ?? 0) + 1);
      }
      continue;
    }
    if (event.kind !== 'pi.live') continue;
    const generation = event.data?.value?.generation;
    if (generation === undefined) continue;
    starts += 1;
    const position = `${conv}\u0001${committed.get(conv) ?? 0}`;
    add(askers, position, process);
    if (generation.message !== undefined) {
      const held = asked.get(position) ?? new Map();
      held.set(identity(generation.message), held.size);
      asked.set(position, held);
      if (!event.snapshot) add(own, position, process);
    }
  }
  if (!known || starts === 0) return null;
  let turns = 0;
  let asks = 0;
  for (const [position, held] of asked) {
    // The ask whose entry was committed answered; with no entry yet, the latest partial is the ask still in flight.
    const answered = answeredBy.has(position) ? answeredBy.get(position) : [...held.keys()].at(-1);
    const cut = [...held.keys()].filter(id => id !== answered).length;
    if (cut > 0) { turns += 1; asks += cut; }
  }
  let possible = 0;
  for (const [position, processes] of askers) {
    const bare = [...processes].filter(who => !(own.get(position)?.has(who)) && answeredProcess.get(position) !== who).sort((x, y) => x - y);
    const ordered = [...processes].sort((x, y) => x - y);
    // Consecutive bare opens (no process of the position between them that committed a partial) are one possible cut ask.
    let runs = 0;
    let previous = -1;
    for (const who of bare) { if (previous < 0 || ordered.indexOf(who) !== ordered.indexOf(previous) + 1) runs += 1; previous = who; }
    if (runs > 0) possible += 1;
  }
  return { proven: { turns, asks }, possible: { turns: possible } };
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
