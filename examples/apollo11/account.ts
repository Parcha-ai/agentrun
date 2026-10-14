// The run's payoff, built by the program from what the run filed: the account (apollo11.account/1), each cite resolved to the look
// that backs it (its fragment, and its key as the receipt); the photo sort's accuracy against NASA's captions; the times the eyes read
// off the scans, checked against NASA's typed transcript; and the look counters, folded from the store's `vision.looks` documents.
// It reads files and parses JSON; it never reads meaning into prose.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LookRecord } from '@parcha/pi-vision';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import type { Dataset, Item, PhotoItem } from './dataset.ts';
import type { TypedLine } from './scripted.ts';

export const ACCOUNT_FORMAT = 'apollo11.account/1';

type Cite = { item: string; receipt: string };
type Output = {
  dataset_sha256: string;
  entries: { mission_time: string; text: string; cites: Cite[] }[];
  windows: { item: string; from_s: number; to_s: number; seen: string; receipt: string }[];
  pages: { item: string; page: number; receipt: string }[];
  photos: { item: string; class: string; receipt: string }[];
};

/** A receipt the run filed, read back: the record when the path is a file under the run's `evidence/` that parses as a look. */
export function receiptAt(root: string, path: string): LookRecord | undefined {
  const at = resolve(root, path);
  if (!path.startsWith('evidence/') || relative(resolve(root), at).startsWith('..') || !existsSync(at)) return undefined;
  try {
    const record = JSON.parse(readFileSync(at, 'utf8')) as LookRecord;
    return record.tool === 'look' && typeof record.facts?.key === 'string' ? record : undefined;
  } catch { return undefined; }
}

/** A page's lines as the eyes read them: the JSON lines of an ok look's answer, a line with no time of its own carrying the time
 *  before it. None when the receipt is no ok look. */
export function pageLines(root: string, receipt: string): { time: string; speaker: string; text: string }[] {
  const record = receiptAt(root, receipt);
  if (!record || record.status !== 'ok') return [];
  let last = '';
  return record.body.split('\n').flatMap((line) => {
    let parsed: { time?: unknown; speaker?: unknown; text?: unknown };
    try { parsed = JSON.parse(line); } catch { return []; }
    if (!parsed || typeof parsed !== 'object') return [];
    const time = typeof parsed.time === 'string' && /^\d\d \d\d \d\d \d\d$/.test(parsed.time) ? parsed.time : last;
    last = time;
    return [{ time, speaker: String(parsed.speaker ?? ''), text: String(parsed.text ?? '') }];
  });
}

/** "DD HH MM SS" as hhh:mm:ss, hours since launch. */
export const missionTime = (time: string) => {
  const [days, hours, minutes, seconds] = time.split(' ').map(Number) as [number, number, number, number];
  return `${String(days * 24 + hours).padStart(3, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/** The landing for the account: every line the pages' receipts hold inside `span`, in mission-time order, each with its page and
 *  receipt; and the film's windows as the run read them. This is the workflow's `landing` call. */
export function landingOf(root: string, input: { pages: Output['pages']; windows: Output['windows']; span: { from: string; to: string } }) {
  const lines = input.pages.flatMap((page) => pageLines(root, page.receipt).filter((line) => line.time && line.time >= input.span.from && line.time <= input.span.to)
    .map((line) => ({ ...line, mission_time: missionTime(line.time), item: page.item, page: page.page, receipt: page.receipt })));
  lines.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.page - b.page));
  return { lines, windows: input.windows.map(({ item, from_s, to_s, seen, receipt }) => ({ item, from_s, to_s, seen, receipt })) };
}

/** The look a cite rests on: an ok look of exactly the item's file (its SHA-256), or why not. */
function backing(root: string, items: Map<string, Item>, cite: Cite): { record: LookRecord } | { why: string } {
  const item = items.get(cite.item);
  if (!item) return { why: `no item ${cite.item} in the data set` };
  const record = receiptAt(root, cite.receipt);
  if (!record) return { why: `${cite.receipt} is not a look the run filed` };
  if (record.status !== 'ok') return { why: `${cite.receipt} is a failed look` };
  if (record.facts.sha256 !== item.sha256) return { why: `${cite.receipt} looked at other bytes than ${cite.item}` };
  return { record };
}

/** A look's place in its file as a URL fragment: `#page=`, `#t=` or `#xywh=percent:`; a look at a whole image is
 *  `#xywh=percent:0,0,100,100`. */
export const fragmentOf = (record: LookRecord) => {
  const fragment = record.facts.fragment.slice(record.facts.fragment.indexOf('#') + 1);
  return fragment ? `#${fragment}` : '#xywh=percent:0,0,100,100';
};

export type Counters = { looks: number; paid: number; kept: number; repeated: number; asked_twice: number; failed: number; cost_usd: number | null; cost_unknown: number };

/** The look counters, from the `vision.looks` documents of a store no process holds. A key's eyes were paid by each entry that is
 *  ok, not native and not `kept`; a key whose only entries are `kept` was paid in a process whose filing a kill cut, once. Repeated:
 *  a key paid by more than one process; asked twice: paid twice by one. Cost: what those payments and the failed looks cost; a
 *  failed look whose request threw may have been billed, so its price is unknown, and one unknown price makes the cost null. */
export function lookCounters(store: string): Counters {
  type Entry = { receipt: string | null; record: LookRecord; incarnation?: string };
  const latest = new Map<string, { looks: Entry[] }>();
  for (const line of recordingLines(store).lines) {
    const data = line.data as { doc?: string; key?: string; value?: unknown };
    if (line.channel === 'durable' && data?.doc === 'vision.looks' && data.value) latest.set(`${data.key}\u0001${line.conv ?? ''}`, data.value as never);
  }
  const counters: Counters = { looks: 0, paid: 0, kept: 0, repeated: 0, asked_twice: 0, failed: 0, cost_usd: 0, cost_unknown: 0 };
  const add = (usd: number | null | undefined) => {
    if (typeof usd !== 'number') counters.cost_unknown += 1;
    counters.cost_usd = counters.cost_usd === null || typeof usd !== 'number' ? null : counters.cost_usd + usd;
  };
  const byKey = new Map<string, Entry[]>();
  for (const value of latest.values()) for (const look of value.looks) byKey.set(look.record.facts.key, [...(byKey.get(look.record.facts.key) ?? []), look]);
  for (const looks of byKey.values()) {
    counters.looks += looks.length;
    const failed = looks.filter((look) => look.record.status === 'failed');
    counters.failed += failed.length;
    for (const look of failed) add(look.record.facts.cost_usd);
    const ok = looks.filter((look) => look.record.status === 'ok' && !look.record.args.native);
    const kept = ok.filter((look) => look.record.facts.kept);
    const paid = ok.filter((look) => !look.record.facts.kept);
    counters.kept += kept.length;
    if (paid.length) {
      counters.paid += paid.length;
      const processes = new Set(paid.map((look) => look.incarnation ?? 'unknown')).size;
      counters.repeated += processes - 1;
      counters.asked_twice += paid.length - processes;
      for (const look of paid) add(look.record.facts.cost_usd);
    } else if (kept.length) {
      counters.paid += 1;
      add(kept[0]!.record.facts.cost_usd);
    }
  }
  return counters;
}

type Score = { right: number; total: number; rate: number };
export type Accuracy = { overall: Score; by_class: Record<string, Score>; confusion: Record<string, Record<string, number>>; unsorted: string[] };

/** The sort against NASA's captions: a photo counts as sorted only with an ok look of its exact file; by class is the share of
 *  that class's photos sorted into it, overall the share of all photos. */
export function accuracy(root: string, dataset: Dataset, rows: Output['photos']): Accuracy {
  const items = new Map(dataset.items.map((item) => [item.id, item]));
  const photos = dataset.items.filter((item): item is PhotoItem => item.kind === 'photo');
  const sorted = new Map(rows.filter((row) => 'record' in backing(root, items, row)).map((row) => [row.item, row.class]));
  const score = (right: number, total: number): Score => ({ right, total, rate: total ? Math.round((right / total) * 1000) / 1000 : 0 });
  const by_class: Accuracy['by_class'] = {};
  const confusion: Accuracy['confusion'] = {};
  for (const name of Object.keys(dataset.classes)) {
    const own = photos.filter((photo) => photo.class === name);
    by_class[name] = score(own.filter((photo) => sorted.get(photo.id) === name).length, own.length);
    confusion[name] = {};
    for (const photo of own) { const said = sorted.get(photo.id) ?? 'unsorted'; confusion[name]![said] = (confusion[name]![said] ?? 0) + 1; }
  }
  const right = photos.filter((photo) => sorted.get(photo.id) === photo.class).length;
  return { overall: score(right, photos.length), by_class, confusion, unsorted: photos.filter((photo) => !sorted.has(photo.id)).map((photo) => photo.id) };
}

/** `truth` is the typed time a misread stands for, null when none is near. */
export type TimesCheck = { pages: number; times: number; in_typed: number; unreadable: number; not_in_typed: { page: number; read: string; truth: string | null; receipt: string }[] };

const secondsOf = (time: string) => { const [d, h, m, s] = time.split(' ').map(Number) as [number, number, number, number]; return ((d * 24 + h) * 60 + m) * 60 + s; };

/** The typed time with the fewest digits unlike `read`'s, among those between the typed times read just before and after it on
 *  the same page (ten minutes past the one there is, when the other is missing; null when there is none): where a misread shows. */
function nearest(read: string, before: string | undefined, after: string | undefined, sorted: readonly string[]): string | null {
  if (!/^\d\d \d\d \d\d \d\d$/.test(read) || (before === undefined && after === undefined)) return null;
  const from = before !== undefined ? secondsOf(before) : secondsOf(after!) - 600;
  const to = after !== undefined ? secondsOf(after) : secondsOf(before!) + 600;
  let best: { time: string; differ: number } | null = null;
  for (const time of sorted) {
    const at = secondsOf(time);
    if (at <= from || at >= to) continue;
    const differ = [...time].filter((char, index) => char !== read[index]).length;
    if (!best || differ < best.differ) best = { time, differ };
  }
  return best?.time ?? null;
}

/** The mission times the eyes read off the scans (their answer is JSON lines, in the receipt), each looked up in NASA's typed
 *  transcript: a time the typed transcript does not hold is a misread, or a typo of the 1969 scan that the typed version corrects;
 *  a "?" is one the eyes said they could not read. */
export function timesCheck(root: string, pages: Output['pages'], typed: readonly TypedLine[]): TimesCheck {
  const known = new Set(typed.map((line) => line.time));
  const sorted = [...known].sort();
  const check: TimesCheck = { pages: 0, times: 0, in_typed: 0, unreadable: 0, not_in_typed: [] };
  for (const page of pages) {
    const record = receiptAt(root, page.receipt);
    if (!record || record.status !== 'ok') continue;
    check.pages += 1;
    const times = record.body.split('\n').flatMap((line) => {
      try { const time = (JSON.parse(line) as { time?: unknown }).time; return typeof time === 'string' && time !== '' ? [time] : []; } catch { return []; }
    });
    times.forEach((time, at) => {
      check.times += 1;
      if (time.includes('?')) check.unreadable += 1;
      else if (known.has(time)) check.in_typed += 1;
      else {
        const before = times.slice(0, at).reverse().find((other) => known.has(other));
        const after = times.slice(at + 1).find((other) => known.has(other));
        check.not_in_typed.push({ page: page.page, read: time, truth: nearest(time, before, after, sorted), receipt: record.facts.key });
      }
    });
  }
  return check;
}

/** The weak eyes' run beside this one: its eyes, the run it was (its recording's `source.run`), the times it read off the same scans
 *  and its photo sort. */
export type WeakEyes = { model: string; source: string; times: TimesCheck; photos: { right: number; total: number } };

export type Account = {
  format: typeof ACCOUNT_FORMAT; dataset_sha256: string; run: string;
  entries: { mission_time: string; text: string; cites: { item: string; fragment: string; receipt: string }[] }[];
  dropped: { entry: number; item: string; why: string }[];
  photos: { item: string; label: string; truth: string; fragment: string; receipt: string }[];
  accuracy: Accuracy;
  transcript: { pages: { item: string; page: number; fragment: string; receipt: string; lines: number }[]; times: TimesCheck };
  film: { item: string; from_s: number; to_s: number; seen: string; fragment: string; receipt: string }[];
  models: { lead: string; eyes: string; scripted: boolean };
  counters: Counters;
  weak_eyes?: WeakEyes;
};

/** What a weak-eyes run's account gives the main one. */
export const weakEyesOf = (weak: Account): WeakEyes => ({ model: weak.models.eyes, source: weak.run, times: weak.transcript.times, photos: { right: weak.accuracy.overall.right, total: weak.accuracy.overall.total } });

/** The account from the run's output, with every cite resolved against the receipts under `root`. */
export function buildAccount(root: string, dataset: Dataset, datasetSha256: string, output: Output, typed: readonly TypedLine[], models: Account['models'], store: string, run: string, weak?: WeakEyes): Account {
  const items = new Map(dataset.items.map((item) => [item.id, item]));
  const dropped: Account['dropped'] = [];
  const resolveCite = (cite: Cite, entry: number) => {
    const found = backing(root, items, cite);
    if ('why' in found) { dropped.push({ entry, item: cite.item, why: found.why }); return []; }
    return [{ item: cite.item, fragment: fragmentOf(found.record), receipt: found.record.facts.key }];
  };
  const keyOf = (path: string) => receiptAt(root, path);
  const placed = <T extends { receipt: string }>(row: T) => { const record = keyOf(row.receipt); return { fragment: record ? fragmentOf(record) : '', receipt: record?.facts.key ?? '' }; };
  const truth = new Map(dataset.items.filter((item): item is PhotoItem => item.kind === 'photo').map((item) => [item.id, item.class]));
  // An entry's time is one the transcript's lines carry, on a page it cites: the film's seconds are no mission time.
  const timesOf = new Map<string, Set<string>>();
  for (const page of output.pages) for (const line of pageLines(root, page.receipt)) if (line.time) timesOf.set(page.receipt, (timesOf.get(page.receipt) ?? new Set()).add(missionTime(line.time)));
  const timed = (entry: Output['entries'][number], at: number) => {
    if (entry.cites.some((cite) => timesOf.get(cite.receipt)?.has(entry.mission_time))) return true;
    dropped.push({ entry: at, item: '', why: `${entry.mission_time} is no time of a line on a page the entry cites` });
    return false;
  };
  return {
    format: ACCOUNT_FORMAT, dataset_sha256: datasetSha256, run,
    entries: output.entries.map((entry, at) => (timed(entry, at) ? { mission_time: entry.mission_time, text: entry.text, cites: entry.cites.flatMap((cite) => resolveCite(cite, at)) } : { mission_time: entry.mission_time, text: entry.text, cites: [] })).filter((entry) => entry.cites.length > 0),
    dropped,
    photos: output.photos.map((row) => ({ item: row.item, label: row.class, truth: truth.get(row.item) ?? '', ...placed(row) })),
    accuracy: accuracy(root, dataset, output.photos),
    transcript: { pages: output.pages.map((row) => ({ item: row.item, page: row.page, lines: pageLines(root, row.receipt).length, ...placed(row) })), times: timesCheck(root, output.pages, typed) },
    film: output.windows.map((row) => ({ item: row.item, from_s: row.from_s, to_s: row.to_s, seen: row.seen, ...placed(row) })),
    models, counters: lookCounters(store), ...(weak ? { weak_eyes: weak } : {}),
  };
}

/** The record the run delivered (`out/record.json`), or null. */
export function outputOf(root: string): Output | null {
  const file = join(root, 'out', 'record.json');
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, 'utf8')) as { record: Output }).record;
}
