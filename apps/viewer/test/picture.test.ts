// The picture panel (RECORDING.md draft 31): the latest `picture` host line at or before the stop, a gap before the
// first, the last kept after the run ends, and no panel for a recording with no picture line; the validator takes a
// picture line, which names no process, and checks the fields it has.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate, type Json, type Line } from '../src/format.ts';
import { picturePanel } from '../src/picture.ts';
import { featuredPanel, panelsFor, type Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';

const sha = (n: number) => n.toString(16).padStart(64, '0');
let seq = 0;
const host = (kind: string, t: number, data: Json): Line => ({ channel: 'live', source: 'host', kind, t, seq: seq++, data });
const picture = (t: number, n: number, extra: Record<string, Json> = {}): Line => ({ ...host('picture', t, { blob: sha(n), label: `frame ${n}`, ...extra }), blobs: [sha(n)] });

const lines: Line[] = [
  host('process.started', 0, { gen: 1 }),
  picture(100, 1),
  picture(200, 2, { commit: 3 }),
  host('kill', 250, { gen: 1, label: 'operator', crossing: null }),
  host('process.started', 260, { gen: 2 }),
  picture(300, 3),
  host('result', 400, { gen: 2, blob: sha(9), title: 'the picture' }),
];

type Seen = { gap: boolean; blob?: string; caption?: string };
const seen = (node: Node): Seen => {
  const text = (each: Node): string => (typeof each === 'string' ? each : 'children' in each && each.children ? each.children.map(text).join(' ') : '');
  const find = (each: Node, test: (n: Node) => boolean): Node | undefined => (test(each) ? each : typeof each !== 'string' && 'children' in each ? (each.children ?? []).map((child) => find(child, test)).find(Boolean) : undefined);
  const img = find(node, (each) => typeof each !== 'string' && each.tag === 'img');
  const caption = find(node, (each) => typeof each !== 'string' && each.tag === 'figcaption');
  return { gap: find(node, (each) => typeof each !== 'string' && 'class' in each && each.class === 'picture-gap') !== undefined,
    ...(img && typeof img !== 'string' && 'blob' in img ? { blob: img.blob } : {}), ...(caption ? { caption: text(caption) } : {}) };
};
const at = (p: number) => seen(picturePanel.view(reduceTo(picturePanel, lines, p), { t: 0 }));

test('the latest picture at or before the stop, a gap before the first, and the last kept after the run ends', () => {
  assert.deepEqual(at(0), { gap: true });
  assert.deepEqual(at(1), { gap: true }, 'the process started, nothing drawn yet');
  assert.deepEqual(at(2), { gap: false, blob: sha(1), caption: 'frame 1 · picture 1' });
  assert.deepEqual(at(3), { gap: false, blob: sha(2), caption: 'frame 2 · drawn at commit 3 · picture 2' });
  assert.equal(at(5).blob, sha(2), 'a kill does not take the picture away: the home side drew it');
  assert.equal(at(6).blob, sha(3));
  assert.equal(at(lines.length).blob, sha(3), 'after the run ends, the last picture');
});

test('a picture line that names no blob draws nothing: the picture before it stays', () => {
  const broken = [...lines.slice(0, 3), host('picture', 210, { label: 'no blob' })];
  assert.equal(seen(picturePanel.view(reduceTo(picturePanel, broken, broken.length), { t: 0 })).blob, sha(2));
  assert.equal(reduceTo(picturePanel, broken, broken.length).count, 2, 'and it is not counted');
});

test('a recording with no picture line draws no picture panel; one with pictures shows it first', () => {
  const none = lines.filter((line) => line.kind !== 'picture');
  assert.equal(panelsFor(none).some((panel) => panel.id === 'picture'), false);
  assert.equal(panelsFor(lines).some((panel) => panel.id === 'picture'), true);
  assert.equal(featuredPanel([picturePanel], lines)?.id, 'picture');
  assert.equal(featuredPanel([picturePanel], none), undefined);
});

test('the validator takes a picture line, which names no process, and checks its blob, label and commit', () => {
  const blobs = new Set([sha(1), sha(2), sha(3), sha(9)]);
  const picturesIn = (more: Line[]) => validate(undefined, more, blobs).filter((problem) => /picture|data\.gen/.test(problem));
  assert.deepEqual(picturesIn(lines), [], 'no gen on a picture line, and that is right');
  assert.match(picturesIn([host('picture', 1, { label: 'no blob' })]).join('\n'), /a picture names its blob/);
  assert.match(picturesIn([host('picture', 1, { blob: sha(1), label: 7 })]).join('\n'), /a picture's label is a string/);
  assert.match(picturesIn([host('picture', 1, { blob: sha(1), commit: 'three' })]).join('\n'), /a picture's commit is a whole number/);
  assert.match(picturesIn([host('picture', 1, { blob: sha(4) })]).join('\n'), /picture blob 0+4 is not in blobs/);
  assert.match(picturesIn([host('kill', 1, { label: 'operator', crossing: null })]).join('\n'), /names its process in data\.gen/, 'every other supervisor line still names its process');
});

test('a scrub to any point equals a fresh reduce to it', () => {
  let state = picturePanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    assert.deepEqual(state, reduceTo(picturePanel, lines, p), `at ${p}`);
    if (p < lines.length && picturePanel.accepts(lines[p]!)) state = picturePanel.reduce(state, lines[p]!);
  }
});
