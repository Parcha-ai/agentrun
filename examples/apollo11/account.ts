// The run's payoff, built by the program from what the run filed: the account (apollo11.account/1), each cite resolved to the look
// that backs it (its fragment, and its key as the receipt); the photo sort's accuracy against NASA's captions; the times the eyes read
// off the scans, checked against NASA's typed transcript; and the look counters, folded from the store's `vision.looks` documents.
// It reads files and parses JSON; it never reads meaning into prose.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LookRecord } from '@parcha/pi-vision';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import type { Dataset, Item, PhotoItem } from './dataset.ts';

export const ACCOUNT_FORMAT = 'apollo11.account/1';

/** One line of the typed transcript: its mission time as typed, the call sign and the words. */
export type TypedLine = { time: string; speaker: string; text: string };

/** The typed transcript's lines, from its markup: a time and a call sign on one line, the words up to the next blank line. */
export function typedLines(html: string): TypedLine[] {
  const lines: TypedLine[] = [];
  const entry = /^(\d\d \d\d \d\d \d\d)\s+<font[^>]*>([^<]+)<\/font>[^\n]*\n([\s\S]*?)<br><br>/gm;
  for (const match of html.matchAll(entry)) lines.push({ time: match[1]!, speaker: match[2]!.trim(), text: match[3]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  return lines;
}


type Cite = { item: string; receipt: string };
export type Output = {
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
export function landingOf(root: string, input: { pages: Output['pages']; windows: Output['windows']; span_from: string; span_to: string }) {
  const lines = input.pages.flatMap((page) => pageLines(root, page.receipt).filter((line) => line.time && line.time >= input.span_from && line.time <= input.span_to)
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

/** A filing as the counters read it. */
export type Filing = { receipt: string | null; record: LookRecord; incarnation?: string };

/** The look counters over the `vision.looks` documents' latest values, each list in filing order (agentrun.recording/1 draft 21).
 *  Per look key, over ok filings that are not native: every filing that is not `kept` is a payment, and a kept filing is one only
 *  as the key's first (a process paid and died before filing it, so that payment belongs to an earlier process). A key's payments
 *  after its first count once each: in repeated when made by another process than the payment before, in asked twice when by the
 *  same. Cost is one `cost_usd` per payment, and a failed look's own price unless it is kept; a failed look whose request threw may
 *  have been billed, so its price is unknown, and one unknown price makes the cost null. */
export function foldLooks(documents: readonly { looks: readonly Filing[] }[]): Counters {
  const counters: Counters = { looks: 0, paid: 0, kept: 0, repeated: 0, asked_twice: 0, failed: 0, cost_usd: 0, cost_unknown: 0 };
  const add = (usd: number | null | undefined) => {
    if (typeof usd !== 'number') counters.cost_unknown += 1;
    counters.cost_usd = counters.cost_usd === null || typeof usd !== 'number' ? null : counters.cost_usd + usd;
  };
  const byKey = new Map<string, Filing[]>();
  for (const value of documents) for (const look of value.looks) byKey.set(look.record.facts.key, [...(byKey.get(look.record.facts.key) ?? []), look]);
  for (const looks of byKey.values()) {
    counters.looks += looks.length;
    for (const look of looks) {
      if (look.record.status !== 'failed') continue;
      counters.failed += 1;
      if (!look.record.facts.kept) add(look.record.facts.cost_usd);
    }
    const payments: string[] = [];
    looks.filter((look) => look.record.status === 'ok' && !look.record.args.native).forEach((look, at) => {
      if (look.record.facts.kept) counters.kept += 1;
      if (look.record.facts.kept && at > 0) return;
      payments.push(look.record.facts.kept ? `before ${look.incarnation ?? 'unknown'}` : look.incarnation ?? 'unknown');
      add(look.record.facts.cost_usd);
    });
    counters.paid += payments.length;
    payments.forEach((by, at) => { if (at > 0) { if (by === payments[at - 1]) counters.asked_twice += 1; else counters.repeated += 1; } });
  }
  return counters;
}

/** The look counters of a store no process holds: `foldLooks` over its `vision.looks` documents. */
export function lookCounters(store: string): Counters {
  const latest = new Map<string, { looks: Filing[] }>();
  for (const line of recordingLines(store).lines) {
    const data = line.data as { doc?: string; key?: string; value?: unknown };
    if (line.channel === 'durable' && data?.doc === 'vision.looks' && data.value) latest.set(`${data.key}\u0001${line.conv ?? ''}`, data.value as never);
  }
  return foldLooks([...latest.values()]);
}

type Score = { right: number; total: number; rate: number };
export type Accuracy = { overall: Score; by_class: Record<string, Score>; confusion: Record<string, Record<string, number>>; unsorted: string[] };

/** The sort against NASA's captions, over the photos the run sorted: a photo counts as sorted only with an ok look of its exact file;
 *  by class is the share of that class's photos sorted into it, overall the share of all of them. */
export function accuracy(root: string, dataset: Dataset, rows: Output['photos']): Accuracy {
  const items = new Map(dataset.items.map((item) => [item.id, item]));
  const asked = new Set(rows.map((row) => row.item));
  const photos = dataset.items.filter((item): item is PhotoItem => item.kind === 'photo' && asked.has(item.id));
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

/** The Apollo 11 part of the result: the landing as entries, each cite resolved to its look, and what the program measured. */
export type Account = {
  format: typeof ACCOUNT_FORMAT; dataset_sha256: string;
  entries: { mission_time: string; text: string; cites: { item: string; fragment: string; receipt: string }[] }[];
  dropped: { entry: number; item: string; why: string }[];
  photos: { item: string; label: string; truth: string; fragment: string; receipt: string }[];
  accuracy: Accuracy;
  transcript: { pages: { item: string; page: number; fragment: string; receipt: string; lines: number }[]; times: TimesCheck };
  film: { item: string; from_s: number; to_s: number; seen: string; fragment: string; receipt: string }[];
  /** The eyes that answered, by the public name their looks carry. */
  eyes: string[];
};

/** The result a run delivers: `agentrun.cited/1`, a row per minute of the landing whose cites name the looks it rests on, with the
 *  Apollo 11 account beside it. */
export type Cited = {
  format: 'agentrun.cited/1'; title: string;
  rows: { label: string; value: string; cites: { look: string; fragment: string; note: string }[] }[];
  apollo11: Account;
};

/** The cited result from what the run read, with every cite resolved against the receipts under `root`. */
export function citedOf(root: string, dataset: Dataset, datasetSha256: string, output: Output, typed: readonly TypedLine[]): Cited {
  const items = new Map(dataset.items.map((item) => [item.id, item]));
  const dropped: Account['dropped'] = [];
  const resolveCite = (cite: Cite, entry: number) => {
    const found = backing(root, items, cite);
    if ('why' in found) { dropped.push({ entry, item: cite.item, why: found.why }); return []; }
    return [{ item: cite.item, fragment: fragmentOf(found.record), receipt: found.record.facts.key, path: cite.receipt }];
  };
  const placed = <T extends { receipt: string }>(row: T) => { const record = receiptAt(root, row.receipt); return { fragment: record ? fragmentOf(record) : '', receipt: record?.facts.key ?? '' }; };
  const truth = new Map(dataset.items.filter((item): item is PhotoItem => item.kind === 'photo').map((item) => [item.id, item.class]));
  // An entry's time is one the transcript's lines carry, on a page it cites: the film's seconds are no mission time.
  const timesOf = new Map<string, Set<string>>();
  for (const page of output.pages) for (const line of pageLines(root, page.receipt)) if (line.time) timesOf.set(page.receipt, (timesOf.get(page.receipt) ?? new Set()).add(missionTime(line.time)));
  // The time is checked against the cites that resolve, so an entry never stands on a cite that was dropped.
  const entryOf = (entry: Output['entries'][number], at: number) => {
    const cites = entry.cites.flatMap((cite) => resolveCite(cite, at));
    if (cites.some((cite) => timesOf.get(cite.path)?.has(entry.mission_time))) return [{ mission_time: entry.mission_time, text: entry.text, cites: cites.map(({ path: _path, ...cite }) => cite) }];
    dropped.push({ entry: at, item: '', why: `${entry.mission_time} is no time of a line on a page the entry cites` });
    return [];
  };
  const entries = output.entries.flatMap(entryOf);
  const eyes = [...new Set([...output.windows, ...output.pages, ...output.photos].flatMap((row) => { const record = receiptAt(root, row.receipt); return record && record.args.model !== 'none' ? [record.args.model] : []; }))].sort();
  return {
    format: 'agentrun.cited/1', title: 'The Apollo 11 landing, minute by minute',
    rows: entries.map((entry) => ({ label: entry.mission_time, value: entry.text, cites: entry.cites.map((cite) => ({ look: cite.receipt, fragment: cite.fragment, note: cite.item })) })),
    apollo11: {
      format: ACCOUNT_FORMAT, dataset_sha256: datasetSha256, entries, dropped,
      photos: output.photos.map((row) => ({ item: row.item, label: row.class, truth: truth.get(row.item) ?? '', ...placed(row) })),
      accuracy: accuracy(root, dataset, output.photos),
      transcript: { pages: output.pages.map((row) => ({ item: row.item, page: row.page, lines: pageLines(root, row.receipt).length, ...placed(row) })), times: timesCheck(root, output.pages, typed) },
      film: output.windows.map((row) => ({ item: row.item, from_s: row.from_s, to_s: row.to_s, seen: row.seen, ...placed(row) })),
      eyes,
    },
  };
}

