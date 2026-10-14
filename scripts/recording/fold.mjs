// The counters of agentrun.recording/1 section 6 that can be folded from a recording's durable lines, plus the processes and
// kills the supervisor wrote. Nothing here reads a live line to count: a live line only shows what is in flight.
//
// `node scripts/recording/fold.mjs <recording-dir>` prints them as JSON.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const stable = value => (Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value));
const argsHashOf = args => createHash('sha256').update(stable(args ?? {})).digest('hex');
const entryOf = line => (Array.isArray(line.data?.model) ? line.data.model[0] : undefined);

/** `repeated` and `asked twice` (section 6), each scoped to ONE call and never across calls. Snapshot lines are state, not events, and are
 *  skipped; a lost branch is events and is folded.
 *  - A workflow effect: an effect id whose outside call COMPLETED in more than one generation, folded over every line of that id. A
 *    revision that reaches `completed`, or a call in its `calls` record that does, counts once, in the generation of the line that
 *    shows it; two effect ids with one intent are two calls.
 *  - An agent's tool call: identity (conv, tool, argsHash of its arguments). An executed result (not reused, not refused) in a later
 *    generation than one that completed in the same conversation is repeated; a second executed result within one generation is asked twice. */
export function repeats(events) {
  const completions = new Map();
  const calls = new Map();
  const executed = new Map();
  for (const event of events) {
    if (event.channel !== 'durable' || event.snapshot) continue;
    if (event.data?.doc === 'agentrun.effects' && event.data.value) {
      const id = event.data.key ?? '';
      const value = event.data.value;
      const gens = completions.get(id) ?? new Set();
      if (value.status === 'completed') gens.add(event.gen ?? 0);
      for (const call of Array.isArray(value.calls) ? value.calls : []) if (call?.status === 'completed') gens.add(event.gen ?? 0);
      completions.set(id, gens);
    }
    const entry = entryOf(event);
    if (event.kind === 'pi.assistant' && entry?.content) for (const part of entry.content) if (part.type === 'toolCall') calls.set(part.id, { tool: part.name, argsHash: argsHashOf(part.arguments) });
    if (event.kind === 'pi.tool-result' && entry?.role === 'toolResult' && entry.details?.refused !== true && entry.details?.effect_status !== 'reused') {
      const call = calls.get(entry.toolCallId);
      if (!call) continue;
      const identity = `${event.conv ?? event.data?.conversationId ?? ''}\u0001${call.tool}\u0001${call.argsHash}`;
      const gens = executed.get(identity) ?? [];
      gens.push(event.gen ?? 0);
      executed.set(identity, gens);
    }
  }
  const effectRepeats = [...completions.values()].filter(gens => gens.size > 1).length;
  let toolRepeats = 0;
  let askedTwice = 0;
  for (const gens of executed.values()) {
    const first = Math.min(...gens);
    toolRepeats += new Set(gens.filter(gen => gen > first)).size > 0 ? 1 : 0;
    const perGen = new Map();
    for (const gen of gens) perGen.set(gen, (perGen.get(gen) ?? 0) + 1);
    askedTwice += [...perGen.values()].filter(count => count > 1).length;
  }
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
    if (!event.snapshot && event.kind === 'pi.assistant') assistantEntries += 1;
    const { doc, key } = event.data ?? {};
    if (typeof doc === 'string' && event.data.value !== undefined) latest.set(`${doc}\u0001${key ?? ''}`, event.data.value);
  }
  const values = doc => [...latest].filter(([id]) => id.startsWith(`${doc}\u0001`)).map(([, value]) => value);
  const effects = values('agentrun.effects');
  const decisions = values('agentrun.decisions').flatMap(value => value.receipts ?? []);
  return {
    processes,
    kills,
    // Workflow effects that reached `completed`: once per id, since the latest value per (doc, key) is the id's last state.
    paidCallsMade: effects.filter(effect => effect.status === 'completed').length,
    // Effects still `unknown` at the end of the run.
    unknown: effects.filter(effect => effect.status === 'unknown').length,
    judgeAsks: { answered: decisions.filter(receipt => !receipt.error).length, failed: decisions.filter(receipt => receipt.error).length },
    modelTurnsCommitted: assistantEntries,
    ...repeats(events),
  };
}

export const readEvents = dir => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node scripts/recording/fold.mjs <recording-dir>'); process.exit(2); }
  console.log(JSON.stringify(fold(readEvents(process.argv[2])), null, 2));
}
