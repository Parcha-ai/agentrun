// The viewer's pure core against a recording cut from a real killed run of the reference job: the format holds, a
// scrub never splits a commit and equals a fresh reduce, and the counters match that run's own ledger.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { citeStop } from '../src/cite.ts';
import { counterFold, countersOf } from '../src/counters.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import { frameFold, pictureAt } from '../src/frames.ts';
import { documentFold, documentsOf } from '../src/documents.ts';
import { lanesOf } from '../src/lanes.ts';
import { linesPanel, panelsShown, register, registry, turnsPanel, type Node } from '../src/panels.ts';
import { reduceTo, snap, stopsOf } from '../src/replay.ts';

const at = (path: string) => new URL(`fixtures/reference-killed/${path}`, import.meta.url);
const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
const lines = parseLines(readFileSync(at('events.jsonl'), 'utf8'));
const blobs = new Set(readdirSync(at('blobs')).map((name) => name.split('.')[0]!));

test('the fixture obeys the format, and each invariant catches its own break', () => {
  assert.deepEqual(validate(manifest, lines, blobs), []);
  const durable = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.channel === 'durable' && line.snapshot !== true);
  const backwards = lines.map((line, index) => (index === durable[5]!.index ? { ...line, commit: 0 } : line));
  assert.match(validate(manifest, backwards).join('\n'), /commit 0 after commit/);
  const repeatedOrder = lines.map((line, index) => (index === durable[2]!.index ? { ...line, commit: durable[1]!.line.commit, order: durable[1]!.line.order } : line));
  assert.match(validate(manifest, repeatedOrder).join('\n'), /\(commit, order\) does not increase/);
  const live = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.channel === 'live' && line.gen === 1);
  const seqBack = lines.map((line, index) => (index === live[1]!.index ? { ...line, seq: 1 } : line));
  assert.match(validate(manifest, seqBack).join('\n'), /seq does not increase in process 1/);
  assert.match(validate({ ...manifest, cost: { usd: 0, parts: { judge: null } } }, lines).join('\n'), /cost.usd is a number though a part is unknown/);
});

test('the manifest\'s chapters name a commit of a generation that is in the recording, and a baseline names a recording', () => {
  const kill = lines.findIndex((line) => line.kind === 'kill');
  const before = lines.slice(0, kill).findLast((line) => line.channel === 'durable')!;
  const chapters = [{ title: 'before the kill', at: { gen: before.gen!, commit: before.commit! }, focus: '/root' }];
  assert.deepEqual(validate({ ...manifest, chapters, baseline: { recording: '../reference-uninterrupted', label: 'the same job, not killed' } }, lines), []);
  assert.match(validate({ ...manifest, chapters: [{ title: 'nowhere', at: { gen: 2, commit: 9999 } }] }, lines).join('\n'), /chapter "nowhere" is at commit 9999 of generation 2, which no durable line holds/);
  assert.match(validate({ ...manifest, chapters: [{ title: 'no gen', at: { commit: before.commit } }] }, lines).join('\n'), /chapters needs a title and at \{ gen, commit \}/);
  assert.match(validate({ ...manifest, baseline: { recording: '../other' } }, lines).join('\n'), /baseline needs recording and label/);
});

test('no stop falls inside a commit, and a scrub to any stop equals a fresh reduce to it', () => {
  const stops = stopsOf(lines);
  for (let p = 1; p < lines.length; p += 1) {
    const before = lines[p - 1]!;
    const after = lines[p]!;
    if (before.channel === 'durable' && after.channel === 'durable' && before.commit === after.commit && !before.snapshot && !after.snapshot) assert.equal(stops[p], false, `stop ${p} splits commit ${before.commit}`);
  }
  for (const fold of [counterFold, frameFold, documentFold, ...panelsShown()]) {
    // One pass, keeping the state at each stop, against a fresh reduce to that stop.
    let state = fold.init();
    for (let p = 0; p <= lines.length; p += 1) {
      if (stops[p]) assert.deepEqual(state, reduceTo(fold, lines, p), `${'id' in fold ? fold.id : 'fold'} at stop ${p}`);
      if (p < lines.length && fold.accepts(lines[p]!)) state = fold.reduce(state, lines[p]!);
    }
  }
  assert.equal(snap(stops, lines.length), lines.length, 'the end is a stop');
});

test('the counters at the end match the run\'s own ledger', () => {
  const counters = countersOf(reduceTo(counterFold, lines, lines.length), true);
  // The run's ledger: tool:search 1, judge:verdict 1, model turns 0 to 3 with turn 2 asked once in each process.
  assert.deepEqual({ paid: counters.paid.total, repeated: counters.repeated, askedTwice: counters.askedTwice, unknown: counters.unknown, inFlight: counters.inFlight },
    { paid: 1, repeated: 0, askedTwice: 0, unknown: 0, inFlight: 0 });
  assert.deepEqual(counters.judge, { answered: 1, failed: 0, reasked: 0 });
  assert.deepEqual(counters.turns, { committed: 4, reasked: null, reaskedTurns: null, reaskedPossible: null }, 'the run asked turn 2 twice, but this export pruned pi.live to its last revision: no ask start is left to prove it');
  assert.deepEqual({ processes: counters.processes, kills: counters.kills }, { processes: 2, kills: 1 });
  assert.equal(counters.journalOpens, 4, 'the store\'s own fact: two journal opens in each process of this build');
  assert.equal(counters.cost, null, 'the scripted judge reports no cost, so the run\'s cost is unknown, never 0');
});

test('the process lane comes from the supervisor\'s lines: two bands, the first ended by the labelled kill', () => {
  const lanes = lanesOf(lines);
  assert.deepEqual(lanes.processes.map((band) => [band.process, band.kill?.label ?? null]), [[1, 'killed in the lead\'s request after the browser read'], [2, null]]);
  assert.equal(lanes.turns.filter((turn) => turn.status === 'failed').length, 1, 'the turn the kill cut');
  assert.equal(lanes.calls.find((call) => call.label === 'search')?.status, 'done');
});

test('?cite lands just after the commit that first wrote the citation', () => {
  const citation = 'evidence/investigate/browser_read-be8651870263.json';
  const p = citeStop(lines, citation)!;
  const wrote = lines.findIndex((line) => line.channel === 'durable' && JSON.stringify(line.data).includes(citation));
  assert.ok(p > wrote, 'after the line that holds it');
  assert.ok(lines.slice(wrote, p).every((line) => line.channel !== 'durable' || line.commit === lines[wrote]!.commit), 'and no later commit');
  assert.equal(citeStop(lines, 'evidence/never-filed.json'), undefined);
});

test('a browser picture: the track when there is one, else the latest frame, and a gap as a gap', () => {
  const line = (kind: string, t: number, data: object, blobs?: string[]): Line => ({ channel: 'live', source: 'browser', kind, gen: 1, t, seq: t, data: data as never, ...(blobs ? { blobs } : {}) });
  const frames = [line('frame', 10, { session: 's1' }, ['f1']), line('frame', 20, { session: 's1' }, ['f2'])];
  let state = frames.reduce(frameFold.reduce, frameFold.init());
  assert.deepEqual(pictureAt(state, 's1', 25), { kind: 'frame', blob: 'f2', t: 20 });
  state = frameFold.reduce(state, line('frame.track', 30, { session: 's1', from: 0, to: 100, fps: 10 }, ['webm']));
  assert.deepEqual(pictureAt(state, 's1', 50), { kind: 'track', blob: 'webm', offset: 0.05 });
  state = frameFold.reduce(state, line('frame.gap', 60, { session: 's1', from: 60, reason: 'process_killed' }));
  assert.deepEqual(pictureAt(state, 's1', 70), { kind: 'gap', reason: 'process_killed', from: 60 });
  assert.deepEqual(pictureAt(state, 'unseen', 70), { kind: 'none' });
});

test('a recording that never committed an ask start shows re-asked turns as not measured, never 0', () => {
  const counters = countersOf(reduceTo(counterFold, lines, lines.length), true);
  assert.equal(counters.turns.reasked, null);
  assert.equal(counters.turns.committed, 4, 'committed turns come from the store all the same');
});

test('a kill\'s crossing is { point, n } or null, and the lane shows its point', () => {
  const crossing = (value: Json) => lines.map((line) => (line.kind === 'kill' ? { ...line, data: { gen: 1, label: 'cut', crossing: value } } : line));
  assert.equal(lanesOf(crossing({ point: 'model.request', n: 3 })).processes[0]!.kill?.crossing, 'model.request');
  assert.deepEqual(validate(manifest, crossing({ point: 'model.request', n: 3 })), []);
  assert.equal(lanesOf(crossing(null)).processes[0]!.kill?.crossing, undefined, 'a kill at no named crossing');
  assert.match(validate(manifest, crossing('model.request turn 2')).join('\n'), /a kill's crossing is \{ point, n \} or null/);
  assert.match(validate(manifest, crossing(5)).join('\n'), /a kill's crossing is \{ point, n \} or null/);
});

test('focus is a view input: the views dim what is outside the branch, keep lines with no path, and drop nothing', () => {
  const nodes = (node: Node): Exclude<Node, string>[] => (typeof node === 'string' ? [] : [node, ...('children' in node ? (node.children ?? []).flatMap(nodes) : [])]);
  const state = reduceTo(linesPanel, lines, lines.length);
  const whole = nodes(linesPanel.view(state, { t: 0 })).filter((node) => node.tag === 'li');
  const focused = nodes(linesPanel.view(state, { t: 0, focus: '/root/steps/0' })).filter((node) => node.tag === 'li');
  assert.equal(focused.length, whole.length, 'no line is dropped for the focus');
  const classOf = (node: Exclude<Node, string>) => ('class' in node ? node.class ?? '' : '');
  const pathOf = (node: Exclude<Node, string>) => ('path' in node ? node.path : undefined);
  assert.ok(focused.some((node) => pathOf(node) !== undefined && !pathOf(node)!.startsWith('/root/steps/0') && classOf(node).includes('dim')), 'a line of another branch is dimmed');
  assert.ok(focused.filter((node) => pathOf(node) === undefined).every((node) => !classOf(node).includes('dim')), 'a line with no path stays');
  assert.ok(focused.filter((node) => pathOf(node)?.startsWith('/root/steps/0')).every((node) => !classOf(node).includes('dim')), 'the focused branch stays');
});

test('the lines panel names the process a supervisor line is about from its data', () => {
  const text = (node: Node): string => (typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(text).join(' ') : '');
  const shown = text(linesPanel.view(reduceTo(linesPanel, lines, lines.length), { t: 0 }));
  assert.match(shown, /kill \(process 1\)/);
  assert.doesNotMatch(shown, /process undefined/);
});

test('an extension\'s panel shows before the shell\'s own two, whatever order the modules load in', (t) => {
  const extension = { ...linesPanel, id: 'an-extension', title: 'An extension' };
  register(extension);
  t.after(() => { registry.splice(registry.indexOf(extension), 1); });
  assert.deepEqual(panelsShown().map((panel) => panel.id), ['an-extension', linesPanel.id, turnsPanel.id]);
});

test('a document is one per (doc, key, conv, task): two conversations each hold their own pi.live', () => {
  const live = (gen: number, commit: number, conv: number, value: Json, snapshot = false): Line =>
    ({ channel: 'durable', source: 'pi', kind: 'pi.live', gen, t: commit, commit, order: conv, conv, data: { doc: 'pi.live', value }, ...(snapshot ? { snapshot: true } : {}) });
  const run = [live(1, 1, 12, { turn: 0 }), live(1, 1, 13, { turn: 0 }), live(1, 2, 12, { turn: 1 }), live(1, 3, 13, { turn: 1 })];
  const shown = (each: Line[]) => documentsOf(reduceTo(documentFold, each, each.length), 'pi.live').map((one) => [one.conv, one.value]);
  assert.deepEqual(shown(run), [[12, { turn: 1 }], [13, { turn: 1 }]], 'a later revision of one conversation\'s pi.live leaves the other\'s');
  assert.deepEqual(shown([...run, live(2, 3, 12, { turn: 1 }, true)]), [[12, { turn: 1 }], [13, { turn: 1 }]], 'a snapshot replaces only its own');
  const restored = [...run, live(2, 2, 12, { turn: 1 }, true)];
  assert.deepEqual(shown(restored), [[12, { turn: 1 }]], 'a restore to commit 2: the snapshot holds conversation 12 only, so 13\'s is gone');
  const tasks = [{ ...live(1, 1, 12, 'a'), kind: 'pi.task-memo', task: 't1', data: { doc: 'pi.task-memo', value: 'a' } }, { ...live(1, 2, 12, 'b'), kind: 'pi.task-memo', task: 't2', data: { doc: 'pi.task-memo', value: 'b' } }];
  assert.equal(documentsOf(reduceTo(documentFold, tasks, 2), 'pi.task-memo').length, 2, 'one per task');
});

test('the result is the supervisor\'s line, a task is a durable string, and the manifest\'s cost is the lines\' fold', () => {
  const result = lines.findIndex((line) => line.kind === 'result');
  assert.match(validate(manifest, lines.map((line, index) => (index === result ? { ...line, gen: 2 } : line))).join('\n'), /a supervisor line \(result\) has no event-level gen/);
  assert.match(validate(manifest, lines.map((line, index) => (index === result ? { ...line, data: { blob: 'x', title: 'y' } } : line))).join('\n'), /a supervisor line \(result\) names its process in data.gen/);
  assert.match(validate(manifest, lines.map((line, index) => (index === result ? { ...line, data: { gen: 2, path: 'out/record.json' } } : line))).join('\n'), /a result names its blob and title in data/);
  const first = lines.findIndex((line) => line.channel === 'durable');
  assert.deepEqual(validate(manifest, lines.map((line, index) => (index === first ? { ...line, task: 'task-7' } : line))), []);
  assert.match(validate(manifest, lines.map((line, index) => (index === first ? { ...line, task: 7 as never } : line))).join('\n'), /task is a durable line's string/);
  assert.match(validate({ ...manifest, cost: { usd: 0, parts: { 'faux/faux-1': 0 } } }, lines).join('\n'), /manifest.cost.usd is 0, but the lines fold to null \(a part is unknown\)/);
});
