// The transport stage (src/transport-view.ts) against the real route recording: where the session is is ONE answer that the token, the lanes' marks
// and the status line all read (so at no stop do they disagree), a scrub is a replay, motion is a function of the clock, and the stage names its
// states in words as well as motion (for a reader who asks for none).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, type Line } from '../src/format.ts';
import { type Node } from '../src/panels.ts';
import { reduceTo, stopsOf } from '../src/replay.ts';
import { transportPanel, type TransportState } from '../src/transport.ts';

const load = (name: string) => parseLines(readFileSync(new URL(`fixtures/${name}/events.jsonl`, import.meta.url), 'utf8'));
const real = load('transport-route-real');
const docker = load('transport-route-docker');
const t4 = load('transport-t4-wait');

type El = { tag: string; class?: string; vars?: Record<string, number>; children?: Node[] };
const isEl = (node: Node | undefined): node is El => node !== undefined && typeof node !== 'string' && 'children' in node;
const textOf = (node: Node | undefined): string => (node === undefined ? '' : typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join(' ') : 'text' in node ? node.text : '');
/** Every element of a view, depth first. */
function walk(node: Node | undefined, out: El[] = []): El[] {
  if (isEl(node)) { out.push(node); for (const child of node.children ?? []) walk(child, out); }
  return out;
}
const has = (node: El, name: string) => (node.class ?? '').split(/\s+/).includes(name);
const stateAt = (lines: Line[], p: number): TransportState => reduceTo(transportPanel, lines, p);
const viewOf = (state: TransportState, t: number, now = t): Node => transportPanel.view(state, { t, now });

/** What the stage says, read back from the view alone. */
function surfaces(view: Node) {
  const all = walk(view);
  const lanes = all.filter((node) => has(node, 'tlane'));
  const name = (lane: El) => textOf(walk(lane).find((node) => has(node, 'lname'))).trim();
  const marks = (kind: string) => lanes.flatMap((lane, index) => (walk(lane).some((node) => has(node, 'mark') && has(node, kind)) ? [{ index, name: name(lane), text: textOf(walk(lane).find((node) => has(node, 'mark') && has(node, kind))) }] : []));
  const story = all.find((node) => has(node, 'tstory'));
  const token = all.find((node) => has(node, 'tok'));
  return { lanes: lanes.map(name), here: marks('here'), leaving: marks('leaving'), arriving: marks('arriving'), story, storyText: textOf(story), token, row: token?.vars?.row, look: (token?.class ?? '').match(/look-(\w+)/)?.[1], dead: lanes.flatMap((lane, index) => (has(lane, 'dead') ? [{ index, name: name(lane) }] : [])) };
}

/** Every stop of a recording, at the time of its point and a little after it (the clock between lines). */
function* moments(lines: Line[]) {
  const stops = stopsOf(lines);
  for (let p = 0; p <= lines.length; p += 1) {
    if (!stops[p]) continue;
    const t = p > 0 ? lines[p - 1]!.t : 0;
    for (const extra of [0, 400, 1500]) yield { p, t, now: t + extra };
  }
}

test('at every stop the token\'s lane, the lane\'s mark and the status line say the same thing', () => {
  let flying = 0;
  let dead = 0;
  let resting = 0;
  for (const [label, lines] of [['route', real], ['docker', docker], ['t4', t4]] as const) {
    for (const { p, t, now } of moments(lines)) {
      const state = stateAt(lines, p);
      if (state.boxes.length === 0 && state.runners.length === 0) continue;
      const s = surfaces(viewOf(state, t, now));
      const where = `${label} p=${p} now=${now}`;
      if (s.token === undefined) { assert.equal(s.here.length + s.leaving.length + s.arriving.length, 0, `${where}: no token, no mark`); continue; }
      if (has(s.story!, 'dead')) {
        dead += 1;
        const named = /(\w+) was killed/.exec(s.storyText)?.[1];
        assert.ok(named !== undefined && s.lanes.includes(named), `${where}: the status line names the lane that was lost`);
        assert.equal(s.look, 'ghost', `${where}: the token is the ghost`);
        assert.equal(s.row, s.lanes.indexOf(named!), `${where}: the ghost is in the lane that was lost (even once its rebuilt box exists)`);
        assert.equal(s.here.length + s.leaving.length + s.arriving.length, 0, `${where}: no lane says the session is here`);
      } else if (has(s.story!, 'flying')) {
        flying += 1;
        assert.equal(s.here.length, 0, `${where}: during a flight no lane says "here"`);
        assert.equal(s.leaving.length, 1, `${where}: one lane is left`);
        assert.equal(s.arriving.length, 1, `${where}: one lane is arrived at`);
        const [from, to] = [s.leaving[0]!, s.arriving[0]!];
        assert.match(s.storyText, new RegExp(`Moving ${from.name} → ${to.name}`), where);
        assert.ok(Math.min(from.index, to.index) <= s.row! && s.row! <= Math.max(from.index, to.index), `${where}: the token is between them`);
        if (s.look === 'take' || s.look === 'resume') assert.equal(s.row, to.index, `${where}: landed, the token is in the target lane`);
        const word = s.arriving[0]!.text.split(': ')[1]!;
        assert.ok(s.storyText.includes(word), `${where}: the lane and the status line name the same phase (${word})`);
        assert.ok(walk(s.story).some((node) => has(node, 'phase') && has(node, 'now')), `${where}: a phase chip is lit`);
      } else {
        resting += 1;
        assert.equal(s.here.length, 1, `${where}: exactly one lane says "here"`);
        assert.equal(s.leaving.length + s.arriving.length, 0, `${where}: nothing is leaving or arriving`);
        assert.equal(s.row, s.here[0]!.index, `${where}: the token is in that lane (an integer row)`);
        assert.match(s.storyText, new RegExp(`The session is at ${s.here[0]!.name}`), where);
      }
    }
  }
  assert.ok(flying > 20 && dead > 3 && resting > 40, `all three states were seen (${flying} flying, ${dead} dead, ${resting} at rest)`);
});

test('a scrub is a replay: the screen at a stop is the same from a fresh reduce and from stepping, at the same clock', () => {
  for (const lines of [real, docker, t4]) {
    let stepped = transportPanel.init();
    let done = 0;
    for (const { p, t, now } of moments(lines)) {
      for (; done < p; done += 1) if (transportPanel.accepts(lines[done]!)) stepped = transportPanel.reduce(stepped, lines[done]!);
      const fresh = stateAt(lines, p);
      assert.equal(JSON.stringify(viewOf(stepped, t, now)), JSON.stringify(viewOf(fresh, t, now)));
      assert.equal(JSON.stringify(viewOf(fresh, t, now)), JSON.stringify(viewOf(fresh, t, now)), 'and the same view twice');
    }
  }
});

test('every var the stage sets is a finite number, and the token is always inside the rail', () => {
  for (const { p, t, now } of moments(real)) {
    const state = stateAt(real, p);
    const view = viewOf(state, t, now);
    const lanes = surfaces(view).lanes.length;
    for (const node of walk(view)) for (const [name, value] of Object.entries(node.vars ?? {})) assert.ok(Number.isFinite(value), `--${name} at p=${p}`);
    const token = surfaces(view).token;
    if (token) assert.ok(token.vars!.row! >= 0 && token.vars!.row! <= Math.max(0, lanes - 1), `row ${token.vars!.row} of ${lanes} lanes`);
  }
});

test('the route\'s story in the lanes: six lanes, the rebuilt box in the same lane, the tile beside chrome, the film card at the end', () => {
  const end = surfaces(viewOf(stateAt(real, real.length), real.at(-1)!.t));
  assert.deepEqual(end.lanes, ['laptop', 'chrome', 'daytona', 'gpu', 'render', 'home']);
  const state = stateAt(real, real.length);
  assert.equal(state.boxes.filter((box) => box.lane === 'daytona').length, 2, 'the killed box and the one that took its place share a lane');
  assert.equal(state.boxes.filter((box) => box.environment === 'daytona-rebuilt')[0]!.lane, 'daytona');
  const view = viewOf(state, real.at(-1)!.t);
  const laneWithTile = walk(view).filter((node) => has(node, 'tlane')).find((lane) => walk(lane).some((node) => has(node, 'ttile') && !has(node, 'none')));
  assert.match(textOf(walk(laneWithTile).find((node) => has(node, 'lname'))), /chrome/, 'the browser tile is beside the lane it runs in');
  assert.ok(walk(laneWithTile).some((node) => (node as { tag: string }).tag === 'frame' || (node.children ?? []).some((child) => typeof child !== 'string' && child.tag === 'frame')), 'the tile is a frame node');
  const card = walk(view).find((node) => has(node, 'filmcard'));
  assert.ok(card, 'the film card closes the story');
  assert.match(textOf(card), /6 places, 5 moves, 2 kills survived/);
  assert.ok((card!.children ?? []).some((child) => typeof child !== 'string' && child.tag === 'a'), 'with the link to the film');
  assert.equal(walk(viewOf(stateAt(real, 30), real[29]!.t)).some((node) => has(node, 'filmcard')), false, 'and not before it');
});

test('the kills read as the lead asked: a red flash and a ghost for a box, a blink in place for a process, the token popping back in the rebuilt box', () => {
  const kill = (kind: string) => real.findIndex((line) => line.source === 'host' && line.kind === 'kill' && (line.data as { kind: string }).kind === kind);
  const box = kill('box');
  const process = kill('process');
  const after = (index: number, extraMs: number) => { const t = real[index]!.t + extraMs; const p = real.findLastIndex((line) => line.t <= t) + 1; return surfaces(viewOf(stateAt(real, p), t, t)); };
  const flash = walk(viewOf(stateAt(real, box + 2), real[box]!.t + 300, real[box]!.t + 300)).find((node) => has(node, 'tlane') && has(node, 'flash'));
  assert.ok(flash && flash.vars!['flash-age']! < 1, 'the killed box\'s lane flashes, young');
  assert.equal(after(box, 3000).look, 'ghost');
  assert.match(after(box, 3000).token!.class ?? '', /look-ghost/);
  const blink = after(process, 300);
  assert.match(blink.token!.class ?? '', /\bblink\b/, 'a process kill is a blink in place');
  assert.ok(Math.abs(blink.token!.vars!.age! - 0.3) < 0.01, `the blink is aged from the kill (0.3 s), not from the token's arrival: ${blink.token!.vars!.age}`);
  assert.doesNotMatch(blink.token!.class ?? '', /\bpop\b/, 'and wins over an arrival\'s pop');
  assert.equal(blink.here.length, 1, 'in place: the session never left its lane');
  assert.doesNotMatch(after(process, 3000).token!.class ?? '', /\bblink\b/, 'and it stops');
  const reborn = real.findIndex((line, index) => index > box && line.source === 'host' && line.kind === 'process.started');
  const popped = after(reborn, 200);
  assert.match(popped.token!.class ?? '', /\bpop\b.*\breborn\b/, 'the token pops back in the rebuilt box');
  assert.match(textOf(popped.token!), /↺ head \d+/);
  assert.equal(popped.here[0]!.name, 'daytona', 'in the same lane the box was lost from');
});

test('a wait the film skips is a hatched band with its seconds', () => {
  const view = viewOf(stateAt(t4, t4.length), t4.at(-1)!.t);
  const band = walk(view).find((node) => has(node, 'skipband'));
  assert.match(textOf(band), /skipped 18 s waiting for a GPU box to be given/);
  assert.ok(walk(view).some((node) => has(node, 'cell') && has(node, 'wait')), 'and its hatched cells');
});

test('no motion: every animated rule of the stage is switched off under prefers-reduced-motion, and the states are told in words', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const stage = html.slice(html.indexOf('/* The transport stage'), html.indexOf('@media (max-width: 640px)'));
  const reduce = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
  const reduceBlock = reduce.slice(0, reduce.indexOf('\n  }') + 4);
  assert.ok(reduceBlock.length > 40);
  const animated = [...stage.matchAll(/([^{}]+)\{[^{}]*\banimation:[^{}]*\}/g)].map((match) => match[1]!.trim()).filter((selector) => !selector.startsWith('@'));
  assert.ok(animated.length >= 8, `the stage has animated rules (${animated.length})`);
  for (const selector of animated) {
    const tail = selector.split(/\s+/).at(-1)!.replace(/^[^.:]*(?=[.:])/, (given) => given).replace(/^b(?=\.)/, 'b');
    const key = tail.includes('::after') ? '::after' : tail;
    const simple = key.split('.').filter(Boolean).at(-1)!;
    assert.ok(reduceBlock.includes(simple.split('::')[0]!) || reduceBlock.includes(key), `${selector} is switched off (looked for ${key})`);
  }
  assert.match(reduceBlock, /animation: none/);
  // Without animation the states are still told: marks, looks, captions and the dead lane carry words and classes.
  const sample = surfaces(viewOf(stateAt(real, real.findLastIndex((line) => line.t <= 29_000) + 1), 29_000, 29_000));
  assert.equal(sample.look, 'ghost');
  assert.match(textOf(sample.token!), /waiting/);
  assert.match(sample.storyText, /was killed/);
  assert.equal(sample.dead.length, 1);
});
