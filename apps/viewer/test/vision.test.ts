// The vision panel against a recording built line by line in the shapes a vision run writes (vision-hand.ts): the
// meters fold from the filed LookRecords only, a kill leaves kept looks and reads cut in flight, a citation opens its
// receipt and moves its lane, a miss shows by its code, and the account's photo sort and weaker eyes are drawn as the
// result says. A second test plays the scripted recording named by VISION_RECORDING, when there is one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { citeStop } from '../src/cite.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import { panelsShown, type Node, type ViewContext } from '../src/panels.ts';
import { reduceTo, stopsOf } from '../src/replay.ts';
import { counterFold, countersOf } from '../src/counters.ts';
import { viewContext } from '../src/app.ts';
import { visionAccountOf, visionKeptChars, visionMeters, visionPanel, type VisionState } from '../src/vision.ts';
import { ACCOUNT, blobs, FILM, K, LOOKS, lines, manifest, PAGES, PHOTOS, RESULT, writeRecording } from './vision-hand.ts';
import { closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => {
  if (typeof node === 'string') return;
  visit(node);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit);
};
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const text = (node: Node) => words(node).replace(/\s+/g, ' ');
const cls = (name: string) => (each: Exclude<Node, string>) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');
const json = (sha: string): Json | undefined => (sha === RESULT ? ACCOUNT as unknown as Json : undefined);
const end = lines.length;
const stateAt = (p: number, run: Line[] = lines): VisionState => reduceTo(visionPanel, run, p);
const viewAt = (p: number, context: Partial<ViewContext> = {}, run: Line[] = lines) => visionPanel.view(stateAt(p, run), { t: run[p - 1]?.t ?? 0, json, ...context });
const killAt = lines.findIndex((line) => line.kind === 'kill');
const restartAt = lines.findIndex((line, at) => at > killAt && line.kind === 'process.started');
const receiptOf = (look: Json) => (look as { receipt: string }).receipt;
/** The panel's meters against the counters the program folded from its own store and wrote into the result. */
const agrees = (meters: ReturnType<typeof visionMeters>, result: Json) => {
  const counted = (result as { counters?: { paid: number; kept: number; repeated: number; asked_twice: number; failed: number; cost_usd: number | null } }).counters;
  if (!counted) return;
  assert.deepEqual({ paid: meters.paid, kept: meters.kept, repeated: meters.repeated, askedTwice: meters.askedTwice, failed: meters.failed },
    { paid: counted.paid, kept: counted.kept, repeated: counted.repeated, askedTwice: counted.asked_twice, failed: counted.failed }, 'the panel folds what the program counted');
  assert.ok(counted.cost_usd === null ? meters.cost === null : Math.abs(meters.cost! - counted.cost_usd) < 1e-9, `spend ${meters.cost} against ${counted.cost_usd}`);
};

test('the hand recording obeys the format, and a scrub of every panel equals a fresh reduce', () => {
  assert.deepEqual(validate(manifest, lines, new Set(blobs.keys())), []);
  assert.ok(panelsShown().some((panel) => panel.id === 'vision'), 'the vision panel registers when its module loads');
  const stops = stopsOf(lines);
  for (const panel of panelsShown()) {
    let state = panel.init();
    for (let p = 0; p <= lines.length; p += 1) {
      if (stops[p]) assert.deepEqual(state, reduceTo(panel, lines, p), `${panel.id} at stop ${p}`);
      if (p < lines.length && panel.accepts(lines[p]!)) state = panel.reduce(state, lines[p]!);
    }
  }
});

test('the meters fold from the filed looks: paid once, kept after the kill, repeated 0, the spend, the misses by code', () => {
  const before = visionMeters(stateAt(killAt));
  assert.deepEqual({ paid: before.paid, kept: before.kept, repeated: before.repeated }, { paid: 5, kept: 0, repeated: 0 }, 'before the kill: film, pages 1 to 3, photo 1');
  const after = visionMeters(stateAt(end));
  assert.deepEqual({ paid: after.paid, kept: after.kept, repeated: after.repeated, askedTwice: after.askedTwice, native: after.native }, { paid: 7, kept: 2, repeated: 0, askedTwice: 0, native: 0 },
    'page 3 was paid before the kill and filed again kept; photo 3 has only its kept filing, so it counts once from it');
  assert.ok(Math.abs(after.cost! - 0.0097) < 1e-9, `the spend counts each answer once: ${after.cost}`);
  assert.deepEqual(after.misses, [['over_budget', 1]]);
  agrees(after, ACCOUNT as unknown as Json);
  assert.equal(after.possible, 0, 'page 3 was filed before the kill, and photo 3 told nothing before it: no possible payment');
  const meters = text(find(viewAt(end), cls('vz-meters'))[0]!);
  for (const shown of ['looks paid 7', 'kept after a kill 2', 'repeated 0', 'possible extra payments 0 (observed)', 'spend $0.0097', 'typed misses 1: over_budget 1']) assert.ok(meters.includes(shown), `the meters show ${shown}: ${meters}`);
});

test('the panel and the counters strip fold the same looks: its spend is the strip\'s cost and the manifest\'s', () => {
  const strip = countersOf(reduceTo(counterFold, lines, lines.length), true);
  const panel = visionMeters(stateAt(end));
  assert.ok(Math.abs(strip.cost! - panel.cost!) < 1e-9, `strip ${strip.cost} against panel ${panel.cost}`);
  assert.equal(manifest.cost.usd, strip.cost);
  assert.deepEqual({ paid: strip.paid.vision, possible: strip.vision.possible, native: strip.vision.native }, { paid: panel.paid, possible: panel.possible, native: panel.native });
});

test('a look its process started and never filed is a possible extra payment, observed, and spend is a lower bound', () => {
  const page2 = LOOKS.page2 as { record: Json; receipt: string };
  const started = (gen: number, seq: number): Line => ({ channel: 'live', source: 'host', kind: 'process.started', t: seq, seq, data: { gen } });
  // Process 1 files page 1 and tells page 2's look, and is killed before page 2 is filed; process 2 never files page 2.
  const run = [started(1, 1), ...lines.filter((line) => line.kind === 'vision.looks' && !line.snapshot && JSON.stringify(line.data).includes(K.page1)).slice(0, 1),
    { channel: 'live', source: 'vision', kind: 'LookEvent', gen: 1, t: 50, seq: 1, conv: 1, data: { tool: 'read', source: 'scans.pdf', record: page2.record, receipt: page2.receipt } } as Line,
    { channel: 'live', source: 'host', kind: 'kill', t: 60, seq: 2, data: { gen: 1, label: 'cut', crossing: null } } as Line, started(2, 3)];
  const meters = visionMeters(reduceTo(visionPanel, run, run.length));
  assert.deepEqual({ paid: meters.paid, possible: meters.possible }, { paid: 1, possible: 1 });
  const shown = text(find(visionPanel.view(reduceTo(visionPanel, run, run.length), { t: 60 }), cls('vz-meters'))[0]!);
  assert.match(shown, /possible extra payments 1 \(observed\)/);
  assert.match(shown, /spend at least \$0\.0018/);
  assert.equal(countersOf(reduceTo(counterFold, run, run.length), true).vision.possible, 1, 'as the strip counts it');
});

test('live lines show what is in flight and change no count but the observed possible payments', () => {
  const durableOnly = lines.filter((line) => line.channel === 'durable' || line.source === 'host');
  const { possible: _observed, ...whole } = visionMeters(stateAt(end));
  const { possible: _none, ...folded } = visionMeters(reduceTo(visionPanel, durableOnly, durableOnly.length));
  assert.deepEqual(folded, whole);
  const inFlight = text(viewAt(killAt));
  assert.match(inFlight, /In flight \(live lines\)/);
  assert.match(inFlight, /reading scans\.pdf p\.3/);
  assert.match(inFlight, /reading photos\/photo-003\.png/);
  assert.doesNotMatch(text(viewAt(end)), /In flight/, 'nothing is in flight at the end');
});

test('a citation opens its receipt and moves its lane: the page with the line\'s box, the film window, the photo', () => {
  const page = viewAt(end, { cite: K.page2 });
  const receipt = text(find(page, cls('vz-receipt'))[0]!);
  for (const shown of ['Receipt', 'scan-pages #page=2', 'Every line with its timestamp', '"time":"00 00 00 40"', 'faux/eyes-sharp', '$0.0018', '1200 in, 80 out', receiptOf(LOOKS.page2)]) assert.ok(receipt.includes(shown), `the receipt shows ${shown}: ${receipt}`);
  assert.match(text(find(page, cls('vz-typed'))[0]!), /00 00 00 40 A An alarm, number 9\. 00 00 00 44 B Go on\./, 'the page as the eyes typed it, line by line');
  const fenced = lines.map((line) => (line.kind === 'vision.looks' && JSON.stringify(line.data).includes(K.page2) ? JSON.parse(JSON.stringify(line).replace('"body":"{', '"body":"```jsonl\\n{').replace('Go on.\\"}"', 'Go on.\\"}\\n```"')) as Line : line));
  assert.match(text(find(viewAt(end, { cite: K.page2 }, fenced), cls('vz-typed'))[0]!), /00 00 00 44 B Go on\./, 'an answer fenced as code reads the same');
  const scan = find(page, (each) => each.tag === 'img' && 'blob' in each && each.blob === PAGES[1]);
  assert.equal(scan.length, 1, 'the pages lane shows page 2');
  const boxes = find(page, cls('vz-box'));
  assert.deepEqual(boxes.map((each) => ('box' in each ? each.box : undefined)), [{ x: 6, y: 8, w: 80, h: 6 }], 'the box the account cites, drawn over the page');
  assert.ok(find(page, cls('hot')).every((chip) => 'cite' in chip && chip.cite === K.page2) && find(page, cls('hot')).length === 1, 'the chip is lit');
  const chips = find(viewAt(end), cls('vz-entry')).flatMap((entry) => find(entry, cls('vz-cite')));
  assert.deepEqual(chips.map((chip) => ('cite' in chip ? chip.cite : undefined)), [K.film, K.page1, K.page2, K.page3], 'every chip selects its receipt');

  const film = viewAt(end, { cite: K.film });
  assert.equal(find(film, cls('cited')).filter((cell) => cls('vz-cell')(cell)).length > 0, true, 'the window is marked on the film');
  assert.match(text(find(film, cls('vz-strip'))[0]!), /Frame at 3\.75 s\. Frame at 11\.25 s\. Frame at 18\.75 s\. Frame at 26\.25 s\./, 'its frames, each with the caption the read gave it');
  assert.deepEqual(find(film, cls('vz-frame')).map((each) => ('blob' in each ? each.blob : undefined)), FILM, 'the pictures the read showed, from its live line');

  assert.deepEqual(find(viewAt(end), cls('vz-thumb')).map((each) => ('blob' in each ? each.blob : undefined)), PHOTOS, 'each photograph as its read showed it, joined by conversation and source');
  const photo = viewAt(end, { cite: K.photo3 });
  assert.equal(find(photo, cls('vz-tile')).filter(cls('cited')).length, 1, 'the photo is outlined');
  assert.match(text(find(photo, cls('vz-receipt'))[0]!), /paid once, before the kill; this filing paid \$0/, 'a kept look says it paid nothing again');
  assert.match(text(viewAt(end, { cite: 'f'.repeat(64) })), /The look this citation names is not filed at this point/);
});

test('?cite= lands after the commit that filed the look it names', () => {
  const p = citeStop(lines, K.page2)!;
  const wrote = lines.findIndex((line) => line.channel === 'durable' && JSON.stringify(line.data).includes(K.page2));
  assert.equal(lines[wrote]!.kind, 'vision.looks');
  assert.ok(p > wrote && lines.slice(wrote, p).every((line) => line.channel !== 'durable' || line.commit === lines[wrote]!.commit));
  const receipt = text(find(viewAt(p, { cite: K.page2 }), cls('vz-receipt'))[0]!);
  assert.match(receipt, /Receipt · scan-pages #page=2/, 'the receipt opens at that stop, before the account exists');
  assert.equal(viewContext(5, manifest as never, { cite: K.page2, json: new Map([[RESULT, ACCOUNT as unknown as Json]]) }).json?.(RESULT), ACCOUNT, 'the shell hands the view the result it read');
  assert.equal(viewContext(5, manifest as never, { cite: K.page2 }).cite, K.page2);
});

test('a miss shows by its code, and a failed look with no code says so', () => {
  const view = viewAt(end, { cite: K.photo2 });
  assert.match(text(find(view, cls('vz-receipt'))[0]!), /missed over_budget: an image over the eyes' limit/);
  assert.equal(find(view, cls('vz-tile')).filter(cls('missed')).length, 1);
  const noCode = lines.map((line) => (JSON.stringify(line.data).includes('"over_budget"') && line.channel === 'durable' ? { ...line, data: JSON.parse(JSON.stringify(line.data).replace(/,"miss":\{[^}]*\}/, '')) } : line));
  assert.deepEqual(visionMeters(stateAt(noCode.length, noCode)).misses, [['code not recorded', 1]]);
});

test('a key paid again in a later generation is repeated, and twice in one is asked twice; an unknown price is unknown', () => {
  const again = (gen: number, commit: number): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen, t: 99_999, commit, order: 0, conv: 1,
    data: { doc: 'vision.looks', key: `again-${commit}`, value: { looks: [{ ...(LOOKS.page1 as object), receipt: `evidence/read/look-again-${commit}.json` }] } } });
  const later = [...lines, again(2, 900)];
  const repeated = visionMeters(stateAt(later.length, later));
  assert.deepEqual({ repeated: repeated.repeated, askedTwice: repeated.askedTwice, paid: repeated.paid }, { repeated: 1, askedTwice: 0, paid: 8 });
  assert.equal(find(viewAt(later.length, {}, later), cls('alarm')).length, 1, 'repeated is drawn as an alarm');
  const twice = [...later, again(2, 901)];
  assert.equal(visionMeters(stateAt(twice.length, twice)).askedTwice, 1);
  const unpriced = lines.map((line) => (line.channel === 'durable' && JSON.stringify(line.data).includes(K.photo1) ? { ...line, data: JSON.parse(JSON.stringify(line.data).replace('"cost_usd":0.0012', '"cost_usd":null')) } : line));
  assert.equal(visionMeters(stateAt(unpriced.length, unpriced)).cost, null);
  assert.match(text(viewAt(unpriced.length, {}, unpriced)), /spend unknown/);
});

test('one document per look key, its filings in a growing list: each filing counts once, and an identical one paid again is repeated', () => {
  const page1 = LOOKS.page1 as { receipt: string; record: Json };
  const keyed = (gen: number, commit: number, filings: Json[], snapshot = false): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen, t: commit, commit, order: 0, conv: 1,
    ...(snapshot ? { snapshot: true } : {}), data: { doc: 'vision.looks', key: K.page1, value: { looks: filings } } });
  const once = [keyed(1, 1, [page1]), keyed(1, 1, [page1], true), keyed(2, 2, [page1, { ...page1, record: { ...(page1.record as object), facts: { ...((page1.record as { facts: object }).facts), kept: true } } }])];
  const kept = visionMeters(reduceTo(visionPanel, once, once.length));
  assert.deepEqual({ paid: kept.paid, kept: kept.kept, repeated: kept.repeated }, { paid: 1, kept: 1, repeated: 0 }, 'the snapshot repeats the list; the kept filing is the second entry');
  const twice = [keyed(1, 1, [page1]), keyed(2, 2, [page1, page1])];
  const again = visionMeters(reduceTo(visionPanel, twice, twice.length));
  assert.deepEqual({ paid: again.paid, repeated: again.repeated }, { paid: 2, repeated: 1 }, 'the same record filed twice is two filings');
});

test('after a restore, a look filed again in the restored list is a new filing, even one identical to a lost one', () => {
  const page1 = LOOKS.page1 as Json;
  const keyed = (gen: number, commit: number, filings: Json[], snapshot = false): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen, t: commit, commit, order: 0, conv: 1,
    ...(snapshot ? { snapshot: true } : {}), data: { doc: 'vision.looks', key: K.page1, value: { looks: filings } } });
  const started = (gen: number): Line => ({ channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: gen, data: { gen } });
  // Paid at commit 5, then the box dies; the run reopens its checkpoint at commit 3, where the list was empty, and pays again.
  const run = [started(1), keyed(1, 1, []), keyed(1, 5, [page1]), started(2), keyed(1, 3, [], true), keyed(2, 4, [page1])];
  const state = reduceTo(visionPanel, run, run.length);
  assert.deepEqual(state.looks.map((look) => [look.gen, look.lost]), [[1, true], [2, false]], 'the lost branch\'s filing stays, marked');
  assert.deepEqual({ paid: visionMeters(state).paid, repeated: visionMeters(state).repeated }, { paid: 2, repeated: 1 }, 'both payments count, the redo as repeated');
});

test('a look first filed kept and paid again after a restore is two payments, the later one repeated', () => {
  const page3 = LOOKS.page3 as Json;
  const page3Kept = LOOKS.page3Kept as Json;
  const keyed = (gen: number, commit: number, filings: Json[], snapshot = false): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen, t: commit, commit, order: 0, conv: 1,
    ...(snapshot ? { snapshot: true } : {}), data: { doc: 'vision.looks', key: K.page3, value: { looks: filings } } });
  const started = (gen: number): Line => ({ channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: gen, data: { gen } });
  // Process 2 files the answer process 1 paid for as kept; the box dies, the run reopens a checkpoint from before the
  // answer was kept, and process 3 asks the eyes again.
  const run = [started(1), keyed(1, 1, []), started(2), keyed(1, 1, [], true), keyed(2, 4, [page3Kept]), started(3), keyed(2, 2, [], true), keyed(3, 3, [page3])];
  const meters = visionMeters(reduceTo(visionPanel, run, run.length));
  assert.deepEqual({ paid: meters.paid, kept: meters.kept, repeated: meters.repeated }, { paid: 2, kept: 1, repeated: 1 });
  assert.ok(Math.abs(meters.cost! - 0.0036) < 1e-9, `both answers are spend: ${meters.cost}`);
  const after = visionMeters(reduceTo(visionPanel, [...run.slice(0, 5), keyed(2, 5, [page3Kept, page3Kept])], 6));
  assert.deepEqual({ paid: after.paid, kept: after.kept }, { paid: 1, kept: 2 }, 'a second kept filing reads back the same payment');
});

test('a read in flight with a negative start still draws', () => {
  const negative = [...lines.slice(0, 2), { channel: 'live', source: 'pi', kind: 'tool_execution_start', gen: 1, t: 21, seq: 999, conv: 1, data: { toolCallId: 'n1', toolName: 'read', args: { path: 'film.mp4', from_s: -5, to_s: 10 } } } as Line];
  assert.match(text(viewAt(negative.length, {}, negative)), /reading film\.mp4 -5-10 s/);
});

test('the account: entries with their chips, the photo sort against the captions, and the weaker eyes\' dropped digits', () => {
  const view = viewAt(end);
  assert.match(text(find(view, cls('vz-account'))[0]!), /000:00:40 An alarm is called out, number 9\. p\.2 · box/);
  const account = text(view);
  assert.match(account, /50% overall, 1 of 2/);
  assert.match(account, /Left out of the account, 1: 000:02:00 is no time of a line on a page the entry cites\./);
  assert.match(account, /Times read off the pages by faux\/eyes-sharp 5 of 5 times read off 3 pages are in the typed transcript · 0 unreadable · 0 not in it/);
  assert.match(account, /The same pages through faux\/eyes-weak Its photo sort: 1 of 2\. Recorded as its own run, vision-hand-weak\. 0 of 2 times read off 1 page are in the typed transcript · 0 unreadable · 2 not in it/);
  const dropped = find(view, cls('vz-drop'));
  assert.deepEqual(dropped.map(text), ['0', '1'], 'one digit dropped from each stamp');
  assert.deepEqual(visionKeptChars('00 00 00 12', '00 00 00 2'), [true, true, true, true, true, true, true, true, true, false, true]);
  const tiles = find(view, cls('vz-tile'));
  assert.deepEqual(tiles.map((tile) => [text(tile).trim(), cls('right')(tile), cls('wrong')(tile)]), [['ground', true, false], ['', false, false], ['crew', false, true]]);
  assert.ok(tiles.every((tile) => 'path' in tile && tile.path?.startsWith('/root/steps/1/items/')), 'a photo tile focuses its branch');
  assert.equal(find(viewAt(end, { focus: '/root/steps/1/items/0' }), cls('dim')).length, 2, 'the other branches dim');
  assert.doesNotMatch(text(find(view, cls('vz-lane'))[1]!), /eyes-weak/, 'the weaker eyes are not drawn in the lanes once the account names them');
  assert.match(text(viewAt(end, { json: () => undefined })), /The account is in the result:/, 'a result the shell has not read is a link');
  assert.equal(visionAccountOf({ format: 'report/1' }), 'the result is report/1, not apollo11.account/1');
  assert.deepEqual(find(view, cls('vz-stamp')).map((stamp) => find(stamp, cls('vz-cite')).map((chip) => ('cite' in chip ? chip.cite : undefined))), [[K.weak1], [K.weak1]], 'a misread opens the look that read it');
  assert.match(text(viewAt(end, { json: () => ({ format: 'report/1' }) })), /the result is report\/1, not apollo11\.account\/1/);
});

test('the badges: the lead never sees an image, the eyes by their names, the kill, and the kept looks', () => {
  const top = text(find(viewAt(end), cls('vz-top'))[0]!);
  for (const shown of ['lead: faux/text-lead', 'the lead never sees an image', 'eyes: faux/eyes-sharp, faux/eyes-weak', 'killed once: two reads in flight', 'resumed · 2 kept']) assert.ok(top.includes(shown), `${shown}: ${top}`);
  assert.match(text(viewAt(0)), /The eyes have not looked at anything yet/);
});

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
test('the page from file:// reads the account from the result blob, and ?cite= opens the look\'s receipt', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-vision-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeRecording(join(out, 'recordings', 'vision-hand'));
  build(join(out, 'dist'), join(out, 'recordings'));
  const page = (query: string) => {
    const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
      '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replaceAll('&#39;', '\'');
  };
  const html = (query: string) => spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`], { encoding: 'utf8', timeout: 60_000 }).stdout;
  const chips = html('r=vision-hand').match(/<span[^>]*class="vz-cite[^"]*"[^>]*>/g) ?? [];
  assert.ok(chips.length >= 4 && chips.every((chip) => /tabindex="0"/.test(chip) && /role="button"/.test(chip)), 'a citation chip is a button a keyboard reaches');
  const ended = page('r=vision-hand');
  for (const shown of ['What the eyes read', '000:00:40 An alarm is called out, number 9. p.2 · box', '50% overall, 1 of 2', 'looks paid 7', 'kept after a kill 2', 'spend $0.0097', 'typed misses 1: over_budget 1']) assert.ok(ended.includes(shown), `the page shows ${shown}`);
  assert.doesNotMatch(ended, /breaks the format/);
  const cited = page(`r=vision-hand&cite=${K.page2}`);
  assert.match(cited, /Receipt · scan-pages #page=2 .* model faux\/eyes-sharp .* price \$0\.0018/, 'the receipt of the cited look, at the commit that filed it');
  assert.match(cited, /The account Not delivered yet/, 'the account is not on screen before its commit');
  assert.match(cited, /clear citation/);
});

test('a redraw after a chip is chosen keeps the account where the reader scrolled it, and the focus on the chip', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-vision-scroll-'));
  const dir = join(out, 'recordings', 'vision-long');
  writeRecording(dir);
  // The same run with an account long enough to scroll: its entries thirty times over.
  const long = Buffer.from(JSON.stringify({ ...ACCOUNT, entries: Array.from({ length: 30 }, () => ACCOUNT.entries).flat() }));
  const sha = createHash('sha256').update(long).digest('hex');
  writeFileSync(join(dir, 'blobs', `${sha}.json`), long);
  for (const file of ['manifest.json', 'events.jsonl']) writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').replaceAll(RESULT, sha));
  build(join(out, 'dist'), join(out, 'recordings'));
  const page = await drivenPage(`${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=vision-long`, join(out, 'profile'));
  t.after(() => closeAll([page], () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
  let ready = false;
  for (let tries = 0; tries < 100 && !ready; tries += 1) { await page.sleep(100); ready = await page.evaluate('(() => { const a = document.querySelector(".vz-account"); return !!a && a.scrollHeight > a.clientHeight + 300; })()') === true; }
  assert.ok(ready, 'the account scrolls');
  const seen = JSON.parse(String(await page.evaluate(`(async () => {
    const account = () => document.querySelector('.vz-account');
    account().scrollTop = 300;
    const chip = [...account().querySelectorAll('.vz-cite')].find((each) => each.getBoundingClientRect().top > account().getBoundingClientRect().top + 40);
    chip.focus();
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const chosen = { replaced: !document.body.contains(chip), top: account().scrollTop, lit: document.activeElement.classList.contains('hot') };
    // The chip scrolled out of view and the same point drawn again: the offset stays, and so does the focus.
    account().scrollTop = account().scrollHeight;
    const bottom = account().scrollTop;
    const lines = [...document.querySelectorAll('.panel')].find((each) => each.scrollWidth > each.clientWidth);
    if (lines) lines.scrollLeft = 40;
    const range = document.querySelector('.controls input[type=range]');
    range.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = [...document.querySelectorAll('.panel')].find((each) => each.scrollWidth > each.clientWidth);
    return JSON.stringify({ ...chosen, kept: account().scrollTop === bottom && bottom > 300, focused: document.activeElement.classList.contains('hot'), overflowed: Boolean(lines), sideways: again?.scrollLeft ?? null });
  })()`)));
  assert.deepEqual(seen, { replaced: true, top: 300, lit: true, kept: true, focused: true, overflowed: true, sideways: 40 },
    'the panels were drawn again, the account kept its offset, the chosen chip has the focus, and a redraw with the chip out of view moves nothing, sideways included');
});

const scripted = process.env.VISION_RECORDING;
test('a recording of the program: the format holds, every cite resolves to a filed look, and a scrub equals a fresh reduce', { skip: scripted && existsSync(scripted) ? false : 'VISION_RECORDING names no recording' }, () => {
  const dir = scripted!;
  const run = parseLines(readFileSync(join(dir, 'events.jsonl'), 'utf8'));
  const recorded = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(validate(recorded, run, new Set(readdirSync(join(dir, 'blobs')).map((name) => name.split('.')[0]!))), []);
  const resultSha = recorded.result.blob as string;
  const resultFile = readdirSync(join(dir, 'blobs')).find((name) => name.startsWith(resultSha))!;
  const result = JSON.parse(readFileSync(join(dir, 'blobs', resultFile), 'utf8')) as Json;
  const account = visionAccountOf(result);
  assert.equal(typeof account, 'object', String(account));
  const state = reduceTo(visionPanel, run, run.length);
  const keys = new Set(state.looks.map((look) => look.key));
  for (const cite of (account as Exclude<typeof account, string>).entries.flatMap((entry) => entry.cites)) {
    assert.ok(keys.has(cite.receipt), `${cite.item}${cite.fragment} cites a filed look`);
    const receipt = find(visionPanel.view(state, { t: 0, cite: cite.receipt, json: (sha) => (sha === resultSha ? result : undefined) }), cls('vz-receipt'))[0];
    assert.match(text(receipt!), /^ ?Receipt/);
  }
  const meters = visionMeters(state);
  assert.equal(meters.repeated, 0);
  agrees(meters, result);
  const stops = stopsOf(run);
  let folded = visionPanel.init();
  for (let p = 0; p <= run.length; p += 1) {
    if (stops[p] && p % 25 === 0) assert.deepEqual(folded, reduceTo(visionPanel, run, p), `vision at stop ${p}`);
    if (p < run.length && visionPanel.accepts(run[p]!)) folded = visionPanel.reduce(folded, run[p]!);
  }
});
