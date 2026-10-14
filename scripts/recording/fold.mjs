// The counters of agentrun.recording/1 section 6 that can be folded from a recording's durable lines, plus the processes and
// kills the supervisor wrote. Nothing here reads a live line to count: a live line only shows what is in flight.
//
// `node scripts/recording/fold.mjs <recording-dir>` prints them as JSON.
import { readFileSync } from 'node:fs';
import { gatewayIntentOf } from '@parcha/agentrun-dsl/recovery';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entryOf = line => (Array.isArray(line.data?.model) ? line.data.model[0] : undefined);

/** Re-asked model turns, OBSERVED (never proven: a turn a kill cut leaves no durable trace). pi's live assistant `message_start` lines are
 *  the asks (a resumed generation emits no `turn_start`): an ask's position is (conv, the number of assistant entries already committed in
 *  that conversation at the ask), and more than one ask at one position, in different processes, is re-asked.
 *  `turns`: positions asked from more than one generation; `asks`: the generations that asked them, summed. */
export function reAskedObserved(events) {
  const committed = new Map();
  for (const event of events) if (event.channel === 'durable' && !event.snapshot && event.kind === 'pi.assistant') committed.set(event.conv ?? 0, [...(committed.get(event.conv ?? 0) ?? []), event.t]);
  const seen = new Map();
  for (const event of events) {
    if (event.channel !== 'live' || event.source !== 'pi' || event.kind !== 'message_start' || event.data?.message?.role !== 'assistant') continue;
    const conv = event.conv ?? 0;
    const key = `${conv}\u0001${(committed.get(conv) ?? []).filter(t => t <= event.t).length}`;
    seen.set(key, new Set([...(seen.get(key) ?? []), event.gen]));
  }
  const many = [...seen.values()].filter(gens => gens.size > 1);
  return { turns: many.length, asks: many.reduce((sum, gens) => sum + gens.size, 0) };
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
          const placed = event.snapshot ? (event.gen ?? 0) - 0.5 : event.gen ?? 0;
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
  const effectRepeats = measured ? [...applied.values()].filter(held => new Set(held.gens).size > 1).length : null;
  let effectAskedTwice = 0;
  for (const held of applied.values()) {
    const perGen = new Map();
    for (const gen of held.gens) perGen.set(gen, (perGen.get(gen) ?? 0) + 1);
    effectAskedTwice += [...perGen.values()].filter(count => count > 1).length;
  }
  let toolRepeats = 0;
  let askedTwice = 0;
  for (const gens of executed.values()) {
    const first = Math.min(...gens);
    if (gens.some(gen => gen > first)) toolRepeats += 1;
    const perGen = new Map();
    for (const gen of gens) perGen.set(gen, (perGen.get(gen) ?? 0) + 1);
    askedTwice += [...perGen.values()].filter(count => count > 1).length;
  }
  return { repeated: { effects: effectRepeats, agentToolCalls: toolRepeats }, askedTwice: askedTwice + (measured ? effectAskedTwice : 0) };
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
    if (!event.snapshot && event.kind === 'pi.assistant') assistantEntries += 1;
    const { doc, key } = event.data ?? {};
    if (typeof doc === 'string' && event.data.value !== undefined) latest.set(`${doc}\u0001${key ?? ''}\u0001${event.conv ?? ''}`, event.data.value);
  }
  const values = doc => [...latest].filter(([id]) => id.startsWith(`${doc}\u0001`)).map(([, value]) => value);
  const effects = values('agentrun.effects');
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
    paidCallsMade: effects.filter(effect => effect.status === 'completed').length,
    // Effects still `unknown` at the end of the run.
    unknown: effects.filter(effect => effect.status === 'unknown').length,
    judgeAsks: { answered: decisions.filter(receipt => !receipt.error).length, failed: decisions.filter(receipt => receipt.error).length },
    modelTurnsCommitted: assistantEntries,
    cost,
    reAskedObserved: reAskedObserved(events),
    ...repeats(events),
  };
}

export const readEvents = dir => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node scripts/recording/fold.mjs <recording-dir>'); process.exit(2); }
  console.log(JSON.stringify(fold(readEvents(process.argv[2])), null, 2));
}
