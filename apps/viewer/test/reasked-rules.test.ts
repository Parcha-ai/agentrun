// Evidence, not a gate: which turns are re-asked under the two rules, on one recording. The legacy rule reads live turn_start lines (the same
// (conversation, turn) started in more than one process); the signed rule reads live assistant message_start lines (an ask at one
// (conversation, committed assistant entries) position in more than one process). The fold reads only the second. This runs on the recording
// named by AUDIT_FIXTURE once it has message_start lines, and reports both counts and their overlap through the test diagnostics.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { counterFold, countersOf } from '../src/counters.ts';
import { parseLines, type Line } from '../src/format.ts';

const fixture = process.env.AUDIT_FIXTURE;
const lines: Line[] = fixture && existsSync(`${fixture}/events.jsonl`) ? parseLines(readFileSync(`${fixture}/events.jsonl`, 'utf8')) : [];
const isAssistantStart = (line: Line) => line.channel === 'live' && line.source === 'pi' && line.kind === 'message_start'
  && ((line.data as { message?: { role?: string }; role?: string })?.message?.role ?? (line.data as { role?: string })?.role) === 'assistant';
const present = lines.some(isAssistantStart);

/** The keys asked in more than one process, from the groups of gens per key. */
const reasked = (groups: Map<string, Set<number>>) => new Set([...groups].filter(([, gens]) => gens.size > 1).map(([key]) => key));

test('the two re-asked rules on one recording: counts and overlap', { skip: !present && 'the recording has no live assistant message_start lines yet' }, (t) => {
  const legacy = new Map<string, Set<number>>();
  for (const line of lines) {
    if (line.channel !== 'live' || line.source !== 'pi' || line.kind !== 'turn_start') continue;
    const turn = (line.data as { turn?: number })?.turn;
    const key = `${line.conv} ${turn}`;
    (legacy.get(key) ?? legacy.set(key, new Set()).get(key)!).add(line.gen ?? 0);
  }
  const state = lines.reduce((s, line) => (counterFold.accepts(line) ? counterFold.reduce(s, line) : s), counterFold.init());
  const signed = new Map(Object.entries(state.observedStarts).map(([key, gens]) => [key, new Set(gens)] as const));
  const a = reasked(legacy);
  const b = reasked(signed);
  const both = [...a].filter((key) => b.has(key));
  t.diagnostic(`turn_start: ${a.size} re-asked of ${legacy.size} turns; message_start: ${b.size} re-asked of ${signed.size} positions; in both: ${both.length}; only turn_start: ${a.size - both.length}; only message_start: ${b.size - both.length}`);
  assert.equal(countersOf(state, true, true).turns.reaskedObserved, b.size, 'the strip shows the message_start count');
});
