// The vision panel: what the eyes read for a lead that is never shown an image, and the account that cites it. Three
// lanes (a film read in windows, scanned pages, photographs), the cited account, the receipt of the look a citation
// names, the meters, and the same pages through other eyes.
//
// What it reads (RECORDING.md section 5, vision, pi and host):
//   vision, durable: a `vision.*` document whose value is `{ looks: [{ receipt, record, item?, images?, miss? }] }`, each
//     `record` a LookRecord as the package filed it, in filing order (one document per look key, or per filing). Every
//     count and the cost fold from these alone (rule 1).
//   pi, durable: the lead's assistant entries, for the model it ran.
//   pi and vision, live: `tool_execution_start` and `_end` of `read`, `LookEvent`, `MissEvent`: what is in flight, never
//     counted. `shown`: the images a read returned
//     before the eyes looked (the lead never receives them), each with the caption before it: the lanes' pictures,
//     joined to a look by its conversation, source and selector.
//   host: `process.started`, `kill`, and `result`, whose JSON blob is the account (`apollo11.account/1`) or a generic
//     cited result (`agentrun.cited/1`), whose pictures (by the blob's type, `ViewContext.blobType`) are drawn small.
// The meters are the shell's own vision fold (`counterFold`, RECORDING.md section 6), so the panel and the counters strip
// agree; a possible payment, from live lines, is labelled observed and makes spend a lower bound.
// Pure: `accepts`, `reduce` and `view` read only their arguments. Kinds it does not know are skipped.
import { counterFold, type CounterState } from './counters.ts';
import { docIdOf, docOf, entryOf } from './durable.ts';
import { isSupervisor, processOf, under, type Json, type Line } from './format.ts';
import { h, register, type Node, type Panel, type ViewContext } from './panels.ts';

type VisionObj = { [key: string]: Json };
const visionObj = (value: Json | undefined): VisionObj | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined);
const visionStr = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
const visionNum = (value: Json | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A picture the eyes saw: its blob, and its second in the film when the host named it. */
/** `keyframe`: not what the eyes saw, but the keyframe a cited result pairs with the look (the row's label). */
export type VisionImage = { blob: string; at?: number; caption?: string; keyframe?: string };
/** One filing of a LookRecord. `cost` is null when the price is not known; a native look has none of its own. */
export type VisionLook = {
  /** The document that filed it (`(doc, key, conv, task)`), and its place in that document's list. */
  doc: string; at: number; receipt: string | null; key: string; status: 'ok' | 'failed'; native: boolean; kept: boolean;
  model: string; ask?: string; body: string; kind: string; sha256: string; fragment: string; source: string; item?: string;
  page?: number; fromS?: number; toS?: number; tokensIn?: number; tokensOut?: number; cost: number | null;
  images: VisionImage[]; miss?: { code: string; reason?: string };
  /** The generation of the first line that carried it, its commit, and whether a restore went back over that commit. */
  gen: number; commit: number; t: number; lost: boolean; path?: string; conv?: number;
};
type VisionRead = { call: string; source: string; fromS?: number; toS?: number; page?: number; process: number; t: number };
export type VisionState = {
  /** Every filing, in the order first seen; a snapshot's copy of one already seen adds nothing. */
  looks: VisionLook[];
  running: Record<string, VisionRead>;
  counters: CounterState;
  /** Live: looks the eyes answered and misses told, by key or receipt, that no durable line has filed yet; a miss with
   *  no receipt is never filed. */
  told: Record<string, { what: 'look' | 'miss'; source: string; fragment?: string; code?: string; receipt: boolean; t: number }>;
  /** Live: the pictures each read showed, by `visionShownKey`. */
  shown: Record<string, VisionImage[]>;
  processes: number;
  kills: { t: number; gen: number; label: string }[];
  result: { blob: string; title: string } | undefined;
  lead: string | undefined;
  visionLines: number;
  highest: number; inSnapshot: boolean; opened: boolean;
};

/** The times the eyes read off the scanned pages, each looked up in a typed transcript: how many, how many it holds,
 *  how many the eyes could not read, and each one it does not hold (with the typed time it stands for, when the run
 *  names it). */
export type VisionTimes = { pages: number; times: number; inTyped: number; unreadable: number; misread: { page: number; read: string; truth?: string; receipt: string }[] };
/** The account a run delivers: its entries, the sentences left out, the photo sort and its accuracy against the
 *  captions, the times read off the pages, and the same pages through weaker eyes. */
export type VisionCite = { item: string; fragment: string; receipt: string };
export type VisionAccount = {
  entries: { time: string; text: string; cites: VisionCite[] }[];
  dropped: string[];
  photos: { item: string; label: string; truth?: string; receipt?: string }[];
  accuracy?: { overall: { right: number; total: number }; byClass: [string, { right: number; total: number }][] };
  times?: VisionTimes;
  /** The same pages and photographs through other eyes, recorded as their own run (`source`). */
  weak?: { model: string; times: VisionTimes; source?: string; photos?: { right: number; total: number } };
};
export const ACCOUNT_FORMAT = 'apollo11.account/1';

/** The generic cited result any run may deliver (`agentrun.cited/1`, RECORDING.md): rows of a label and a value,
 *  each citing what it was read from: a file in `blobs/`, a look by its key, and where in it. */
export type VisionCitedRow = { label: string; value: string; note?: string; cites: { blob?: string; look?: string; fragment: string; url?: string; at?: string; note?: string }[] };
export type VisionCitedResult = { title?: string; rows: VisionCitedRow[] };
export const CITED_FORMAT = 'agentrun.cited/1';

const visionImages = (value: Json | undefined): VisionImage[] => (Array.isArray(value) ? value.flatMap((each): VisionImage[] => {
  if (typeof each === 'string') return [{ blob: each }];
  const image = visionObj(each);
  const blob = visionStr(image?.blob);
  const at = visionNum(image?.at);
  return blob ? [{ blob, ...(at !== undefined ? { at } : {}) }] : [];
}) : []);

/** The window a `#t=` fragment names, from its own text (the package writes `t=from[,to]`). */
const visionWindow = (fragment: string): { from?: number; to?: number } => {
  const t = fragment.replace(/^#/, '').split('&').find((part) => part.startsWith('t='));
  const [from, to] = (t?.slice(2) ?? '').split(',').map((value) => (value === '' ? undefined : Number(value)));
  return { ...(from !== undefined && Number.isFinite(from) ? { from } : {}), ...(to !== undefined && Number.isFinite(to) ? { to } : {}) };
};
export const visionPage = (fragment: string): number | undefined => {
  const page = fragment.replace(/^#/, '').split('&').find((part) => part.startsWith('page='));
  const value = page ? Number(page.slice(5).split('-')[0]) : NaN;
  return Number.isInteger(value) && value >= 1 ? value : undefined;
};
/** A `#xywh=percent:x,y,w,h` region, in percent of the whole. */
export const visionRegion = (fragment: string): { x: number; y: number; w: number; h: number } | undefined => {
  const part = fragment.replace(/^#/, '').split('&').find((each) => each.startsWith('xywh=percent:'));
  const values = part?.slice('xywh=percent:'.length).split(',').map(Number);
  return values && values.length === 4 && values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) ? { x: values[0]!, y: values[1]!, w: values[2]!, h: values[3]! } : undefined;
};

/** The filings a `vision.*` document line holds, each as one look, with how many the list holds. */
function visionLooksOf(line: Line, gen: number): { doc: string; length: number; looks: VisionLook[] } | undefined {
  const doc = docOf(line);
  const listed = doc && doc.doc.startsWith('vision.') ? visionObj(doc.value)?.looks : undefined;
  if (!Array.isArray(listed)) return undefined;
  const id = docIdOf(line, doc!);
  return { doc: id, length: listed.length, looks: listed.flatMap((each, index): VisionLook[] => {
    const filing = visionObj(each);
    const record = visionObj(filing?.record);
    const args = visionObj(record?.args);
    const facts = visionObj(record?.facts);
    const key = visionStr(facts?.key);
    if (!filing || !record || !args || !facts || key === undefined) return [];
    const receipt = visionStr(filing.receipt) ?? null;
    const fragment = visionStr(facts.fragment) ?? '';
    const window = visionWindow(fragment);
    const fromS = visionNum(args.from_s) ?? window.from;
    const toS = visionNum(args.to_s) ?? window.to;
    const page = visionNum(args.page) ?? visionPage(fragment);
    const ask = visionStr(args.ask);
    const item = visionStr(filing.item);
    const miss = visionObj(filing.miss);
    const code = visionStr(miss?.code) ?? visionStr(facts.miss);
    const reason = visionStr(miss?.reason);
    const tokensIn = visionNum(facts.tokens_in);
    const tokensOut = visionNum(facts.tokens_out);
    return [{
      doc: id, at: index, receipt, key, status: record.status === 'ok' ? 'ok' : 'failed',
      native: args.native === true, kept: facts.kept === true, model: visionStr(args.model) ?? 'not recorded', body: visionStr(record.body) ?? '',
      kind: visionStr(facts.kind) ?? 'unknown', sha256: visionStr(facts.sha256) ?? '', fragment, source: visionStr(args.path) ?? '',
      ...(ask !== undefined ? { ask } : {}), ...(item !== undefined ? { item } : {}), ...(page !== undefined ? { page } : {}),
      ...(fromS !== undefined ? { fromS } : {}), ...(toS !== undefined ? { toS } : {}),
      ...(tokensIn !== undefined ? { tokensIn } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}),
      cost: visionNum(facts.cost_usd) ?? null, images: visionImages(filing.images),
      ...(code !== undefined ? { miss: { code, ...(reason !== undefined ? { reason } : {}) } } : {}),
      gen, commit: line.commit ?? 0, t: line.t, lost: false, ...(line.path !== undefined ? { path: line.path } : {}), ...(line.conv !== undefined ? { conv: line.conv } : {}),
    }];
  }) };
}

/** A look the eyes paid for in this filing: answered, not the lead's own, and not an answer read back after a kill. */
export const visionPaid = (look: VisionLook) => look.status === 'ok' && !look.native && !look.kept;

const visionKnown = (line: Line): boolean => {
  if (line.channel === 'durable') return true;
  if (isSupervisor(line)) return line.kind === 'process.started' || line.kind === 'kill' || line.kind === 'result';
  if (line.source === 'pi') return line.kind === 'tool_execution_start' || line.kind === 'tool_execution_end';
  return line.source === 'vision' && (line.kind === 'LookEvent' || line.kind === 'MissEvent' || line.kind === 'shown');
};

/** Which read a picture or a look belongs to: its conversation, its source and what of it was read. */
const visionShownKey = (conv: number | undefined, source: string, page: number | undefined, fromS: number | undefined, toS: number | undefined) => [conv ?? '', source, page ?? '', fromS ?? '', toS ?? ''].join('\u0001');

export const visionInit = (): VisionState => ({ looks: [], running: {}, counters: counterFold.init(), told: {}, shown: {}, processes: 0, kills: [], result: undefined, lead: undefined, visionLines: 0, highest: -1, inSnapshot: false, opened: false });

function visionReduce(start: VisionState, line: Line): VisionState {
  const before = counterFold.accepts(line) ? { ...start, counters: counterFold.reduce(start.counters, line) } : start;
  if (!visionKnown(line)) return before;
  if (line.channel === 'durable') {
    if (line.commit === undefined) return before;
    let state: VisionState = before;
    // A process's snapshot whose commit is below one seen is a restore (RECORDING.md 3.2): the looks filed above it
    // are the lost branch. They happened and were paid, so they stay, marked.
    const first = line.snapshot === true && (before.opened || !before.inSnapshot);
    if (first && line.commit < before.highest) state = { ...state, highest: line.commit, looks: state.looks.map((look) => (look.commit > line.commit! && !look.lost ? { ...look, lost: true } : look)) };
    else state = { ...state, highest: Math.max(before.highest, line.commit) };
    state = { ...state, inSnapshot: line.snapshot === true, opened: before.opened && line.snapshot !== true };
    // A durable line's gen is the driver's at its commit; with none, the process count: a snapshot's own commits are an
    // earlier process's.
    const gen = line.gen ?? Math.max(1, line.snapshot === true ? state.processes - 1 : state.processes);
    const filed = visionLooksOf(line, gen);
    if (filed) {
      // A document's list of filings only grows, and every revision carries all of it, a snapshot's included: the places
      // beyond those of the branch the store holds are new filings, whatever they hold (a lost branch's stay, marked).
      const held = state.looks.reduce((most, look) => (look.doc === filed.doc && !look.lost ? Math.max(most, look.at + 1) : most), 0);
      const fresh = filed.looks.filter((look) => look.at >= held);
      const heard = new Set(fresh.flatMap((look) => [look.key, ...(look.receipt ? [look.receipt] : [])]));
      const told = Object.keys(state.told).some((id) => heard.has(id)) ? Object.fromEntries(Object.entries(state.told).filter(([id]) => !heard.has(id))) : state.told;
      return { ...state, looks: fresh.length ? [...state.looks, ...fresh] : state.looks, told, visionLines: state.visionLines + 1 };
    }
    if (state.lead !== undefined) return state;
    const assistant = entryOf(line)?.model.find((message) => message.role === 'assistant') as { provider?: Json; model?: Json } | undefined;
    return typeof assistant?.provider === 'string' && typeof assistant.model === 'string' ? { ...state, lead: `${assistant.provider}/${assistant.model}` } : state;
  }
  if (isSupervisor(line)) {
    const data = visionObj(line.data) ?? {};
    if (line.kind === 'process.started') return { ...before, processes: before.processes + 1, opened: true };
    if (line.kind === 'kill') {
      const gen = processOf(line) ?? before.processes;
      return { ...before, kills: [...before.kills, { t: line.t, gen, label: visionStr(data.label) ?? 'killed' }],
        running: Object.fromEntries(Object.entries(before.running).filter(([, read]) => read.process !== gen)) };
    }
    const blob = visionStr(data.blob);
    return line.kind === 'result' && blob ? { ...before, result: { blob, title: visionStr(data.title) ?? 'The result' } } : before;
  }
  const data = visionObj(line.data) ?? {};
  if (line.source === 'pi') {
    const call = visionStr(data.toolCallId);
    if (call === undefined || data.toolName !== 'read') return before;
    if (line.kind === 'tool_execution_end') {
      if (before.running[call] === undefined) return before;
      const { [call]: _ended, ...running } = before.running;
      return { ...before, running };
    }
    const args = visionObj(data.args) ?? {};
    const fromS = visionNum(args.from_s);
    const toS = visionNum(args.to_s);
    const page = visionNum(args.page);
    return { ...before, running: { ...before.running, [call]: { call, source: visionStr(args.path) ?? '', ...(fromS !== undefined ? { fromS } : {}), ...(toS !== undefined ? { toS } : {}), ...(page !== undefined ? { page } : {}), process: line.gen ?? before.processes, t: line.t } } };
  }
  if (line.kind === 'shown') {
    const media = visionObj(data.media) ?? {};
    const conv = line.conv ?? (Number.isInteger(Number(data.conversationId)) ? Number(data.conversationId) : undefined);
    const blocks = Array.isArray(data.content) ? data.content.map((block) => visionObj(block) ?? {}) : [];
    const images = blocks.flatMap((block, at): VisionImage[] => {
      const blob = block.type === 'image' ? visionStr(block.blob) : undefined;
      const before = blocks[at - 1];
      const caption = before?.type === 'text' ? visionStr(before.text) : undefined;
      return blob ? [{ blob, ...(caption ? { caption } : {}) }] : [];
    });
    const key = visionShownKey(conv, visionStr(media.path) ?? '', visionNum(media.page), visionNum(media.fromS), visionNum(media.toS));
    return images.length ? { ...before, shown: { ...before.shown, [key]: images } } : before;
  }
  if (line.kind === 'LookEvent') {
    const record = visionObj(data.record);
    const key = visionStr(visionObj(record?.facts)?.key);
    if (key === undefined || before.looks.some((look) => look.key === key)) return before;
    const fragment = visionStr(data.fragment);
    return { ...before, told: { ...before.told, [key]: { what: 'look', source: visionStr(data.source) ?? '', ...(fragment ? { fragment } : {}), receipt: typeof data.receipt === 'string', t: line.t } } };
  }
  const receipt = visionStr(data.receipt);
  const id = receipt ?? `miss ${line.gen ?? 0} ${line.seq ?? 0}`;
  if (receipt !== undefined && before.looks.some((look) => look.receipt === receipt)) return before;
  return { ...before, told: { ...before.told, [id]: { what: 'miss', source: visionStr(data.source) ?? '', code: visionStr(data.code) ?? 'not named', receipt: receipt !== undefined, t: line.t } } };
}

// ---- what the meters fold ----------------------------------------------------------------------------------------

export type VisionMeters = {
  paid: number; kept: number; repeated: number; askedTwice: number; native: number;
  /** Looks live lines show started in a process that ended without filing its key: possible payments, observed. */
  possible: number;
  /** The looks' price, once per payment and with each failed look's own: null when any of them is unknown; a lower bound
   *  when a possible payment is not in it. */
  cost: number | null;
  misses: [string, number][];
  failed: number;
  eyes: string[];
};

/** The meters at a stop. `ended`: the run delivered its result, so no process is left to file a look it started. */
export function visionMeters(state: VisionState, ended = state.result !== undefined): VisionMeters {
  // Payments per look key, from the shell's fold (RECORDING.md section 6): each ok filing that is not kept, and a key
  // whose first ok filing is kept once, a generation before it. One after the first of a key is an extra payment:
  // repeated when its generation is later than the one before it, asked twice when it is the same.
  const looks = state.counters.looks;
  const extras = { repeated: 0, askedTwice: 0 };
  for (const gens of Object.values(looks.gens)) gens.forEach((gen, at) => { if (at > 0) { if (gen === gens[at - 1]) extras.askedTwice += 1; else extras.repeated += 1; } });
  const possible = Object.entries(looks.started).filter(([at]) => ended || Number(at.split(' ')[0]) < state.counters.processes || looks.ended[at.split(' ')[0]!])
    .reduce((sum, [, count]) => sum + count, 0);
  const failed = state.looks.filter((look) => look.status === 'failed');
  const codes = new Map<string, number>();
  for (const look of failed) codes.set(look.miss?.code ?? 'code not recorded', (codes.get(look.miss?.code ?? 'code not recorded') ?? 0) + 1);
  return {
    paid: Object.values(looks.gens).reduce((sum, gens) => sum + gens.length, 0), kept: state.looks.filter((look) => look.kept && !look.native).length, ...extras,
    native: looks.native, possible,
    cost: looks.costs.some((usd) => usd === null) ? null : looks.costs.reduce<number>((sum, usd) => sum + (usd ?? 0), 0),
    misses: [...codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), failed: failed.length,
    eyes: [...new Set(state.looks.filter((look) => !look.native && look.model !== 'none').map((look) => look.model))],
  };
}

/** The account in a result blob, or why it is not one this panel reads. */
export function visionAccountOf(value: Json | undefined): VisionAccount | string {
  const result = visionObj(value);
  if (!result) return 'the result is not a JSON object';
  if (result.format !== ACCOUNT_FORMAT) return `the result is ${typeof result.format === 'string' ? result.format : 'of no named format'}, not ${ACCOUNT_FORMAT}`;
  const entries = (Array.isArray(result.entries) ? result.entries : []).flatMap((each) => {
    const entry = visionObj(each);
    if (!entry) return [];
    const cites = (Array.isArray(entry.cites) ? entry.cites : []).flatMap((one): VisionCite[] => {
      const cite = visionObj(one);
      const receipt = visionStr(cite?.receipt);
      return cite && receipt ? [{ item: visionStr(cite.item) ?? '', fragment: visionStr(cite.fragment) ?? '', receipt }] : [];
    });
    return [{ time: visionStr(entry.mission_time) ?? '', text: visionStr(entry.text) ?? '', cites }];
  });
  const photos = (Array.isArray(result.photos) ? result.photos : []).flatMap((each) => {
    const photo = visionObj(each);
    const item = visionStr(photo?.item);
    const label = visionStr(photo?.label);
    const truth = visionStr(photo?.truth);
    const receipt = visionStr(photo?.receipt);
    return item && label ? [{ item, label, ...(truth ? { truth } : {}), ...(receipt ? { receipt } : {}) }] : [];
  });
  const tally = (value: Json | undefined) => {
    const each = visionObj(value);
    const right = visionNum(each?.right);
    const total = visionNum(each?.total);
    return right !== undefined && total !== undefined ? { right, total } : undefined;
  };
  const accuracy = visionObj(result.accuracy);
  const overall = tally(accuracy?.overall);
  const byClass = Object.entries(visionObj(accuracy?.by_class) ?? {}).flatMap(([name, value]) => { const counted = tally(value); return counted ? [[name, counted] as [string, { right: number; total: number }]] : []; });
  const timesOf = (value: Json | undefined): VisionTimes | undefined => {
    const times = visionObj(value);
    const counts = ['pages', 'times', 'in_typed', 'unreadable'].map((field) => visionNum(times?.[field]));
    if (!times || counts.some((count) => count === undefined)) return undefined;
    const misread = (Array.isArray(times.not_in_typed) ? times.not_in_typed : []).flatMap((each) => {
      const one = visionObj(each);
      const page = visionNum(one?.page);
      const read = visionStr(one?.read);
      const truth = visionStr(one?.truth);
      return page !== undefined && read !== undefined ? [{ page, read, ...(truth ? { truth } : {}), receipt: visionStr(one?.receipt) ?? '' }] : [];
    });
    return { pages: counts[0]!, times: counts[1]!, inTyped: counts[2]!, unreadable: counts[3]!, misread };
  };
  const times = timesOf(visionObj(result.transcript)?.times);
  const weak = visionObj(result.weak_eyes);
  const weakTimes = timesOf(weak?.times);
  const dropped = (Array.isArray(result.dropped) ? result.dropped : []).flatMap((each) => { const why = visionStr(visionObj(each)?.why); return why ? [why] : []; });
  return {
    entries, dropped, photos,
    ...(overall ? { accuracy: { overall, byClass } } : {}),
    ...(times ? { times } : {}),
    ...(weak && visionStr(weak.model) && weakTimes ? { weak: { model: visionStr(weak.model)!, times: weakTimes, ...(visionStr(weak.source) ? { source: visionStr(weak.source)! } : {}), ...(tally(weak.photos) ? { photos: tally(weak.photos)! } : {}) } } : {}),
  };
}

/** The generic cited result in a result blob, or undefined when it is not one. A cite names a blob, a look or both, and
 *  may say the page it was read from and when (`url`, `at`); one with a url alone is linked, not kept; one that names none
 *  of them is left out, and a row may cite nothing. */
export function visionCitedOf(value: Json | undefined): VisionCitedResult | undefined {
  const result = visionObj(value);
  if (result?.format !== CITED_FORMAT) return undefined;
  const rows = (Array.isArray(result.rows) ? result.rows : []).flatMap((each): VisionCitedRow[] => {
    const row = visionObj(each);
    const label = visionStr(row?.label);
    const value = typeof row?.value === 'number' ? String(row.value) : visionStr(row?.value);
    if (!row || label === undefined || value === undefined) return [];
    const cites = (Array.isArray(row.cites) ? row.cites : []).flatMap((one) => {
      const cite = visionObj(one);
      const blob = visionStr(cite?.blob);
      const look = visionStr(cite?.look);
      const note = visionStr(cite?.note);
      const url = visionStr(cite?.url);
      const at = visionStr(cite?.at);
      return blob || look || url ? [{ ...(blob ? { blob } : {}), ...(look ? { look } : {}), fragment: visionStr(cite?.fragment) ?? '', ...(url ? { url } : {}), ...(at ? { at } : {}), ...(note ? { note } : {}) }] : [];
    });
    const note = visionStr(row.note);
    return [{ label, value, ...(note ? { note } : {}), cites }];
  });
  const title = visionStr(result.title);
  return { ...(title ? { title } : {}), rows };
}

/** Which characters of `truth` the reading kept, by a longest common subsequence: a dropped digit is one it did not. */
export function visionKeptChars(truth: string, read: string): boolean[] {
  const rows = truth.length;
  const cols = read.length;
  const best = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) for (let j = cols - 1; j >= 0; j -= 1) best[i]![j] = truth[i] === read[j] ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
  const kept = new Array<boolean>(rows).fill(false);
  for (let i = 0, j = 0; i < rows && j < cols;) {
    if (truth[i] === read[j]) { kept[i] = true; i += 1; j += 1; } else if (best[i + 1]![j]! >= best[i]![j + 1]!) i += 1; else j += 1;
  }
  return kept;
}

// ---- the screen ---------------------------------------------------------------------------------------------------

const VISION_CELLS = 60;
const visionMoney = (usd: number | null) => (usd === null ? 'unknown' : `$${usd.toFixed(4)}`);
const visionShort = (sha: string) => (sha.length > 12 ? `${sha.slice(0, 6)}…${sha.slice(-4)}` : sha);
const visionLane = (look: VisionLook): 'film' | 'pages' | 'photos' | undefined => (look.kind === 'video' ? 'film' : look.kind === 'pdf' ? 'pages' : look.kind === 'image' ? 'photos' : undefined);
/** A citation chip's words: the page, the window, and a box when the fragment names one. */
export const visionChipText = (fragment: string): string => {
  const page = visionPage(fragment);
  const window = visionWindow(fragment);
  const parts = [...(page !== undefined ? [`p.${page}`] : []), ...(window.from !== undefined ? [`#t=${window.from}${window.to !== undefined ? `,${window.to}` : ''}`] : []), ...(visionRegion(fragment) ? ['box'] : [])];
  return parts.length ? parts.join(' · ') : fragment || 'cited';
};

/** The look a citation names (its receipt is the look's key): the paid filing first, else the latest. */
const visionCited = (state: VisionState, key: string | undefined): VisionLook | undefined =>
  key === undefined ? undefined : state.looks.find((look) => look.key === key && visionPaid(look)) ?? state.looks.findLast((look) => look.key === key);

/** A picture, or a cell saying the recording has none for this look. */
const visionPicture = (image: VisionImage | undefined, alt: string, className: string, quiet = false): Node =>
  (image ? { tag: 'img', blob: image.blob, alt, class: className } : h('span', { class: `${className} vz-nopic`, title: 'no picture in this recording' }, quiet ? '' : 'no picture in this recording'));

/** An answer the eyes gave as JSON lines of `{ time, speaker, text }` (a page transcribed as it was asked to be, fenced
 *  as code or not), as typed lines; any other answer as it is. */
function visionSaid(head: string, body: string): Node {
  const rows = body.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('```')).map((line) => { try { return visionObj(JSON.parse(line) as Json); } catch { return undefined; } });
  const typed = rows.length > 0 && rows.every((row) => typeof row?.text === 'string');
  return h('div', { class: 'vz-said' }, h('b', {}, head), typed
    ? h('div', { class: 'vz-typed' }, ...rows.map((row) => h('div', {}, h('span', { class: 'vz-time' }, visionStr(row!.time) || '·'), ` ${visionStr(row!.speaker) ?? ''}  ${visionStr(row!.text)}`)))
    : ` ${body}`);
}

/** One look per key in a lane: the paid filing, else the first one filed (a key whose paid filing a kill lost). */
const visionOnce = (looks: VisionLook[]): VisionLook[] => {
  const chosen = new Map<string, VisionLook>();
  for (const look of looks) { const held = chosen.get(look.key); if (!held || (!visionPaid(held) && visionPaid(look))) chosen.set(look.key, look); }
  return [...chosen.values()];
};

function visionFilm(looks: VisionLook[], state: VisionState, chosen: VisionLook | undefined): Node {
  const film = visionOnce(looks.filter((look) => visionLane(look) === 'film'));
  const running = Object.values(state.running).filter((read) => read.fromS !== undefined || read.toS !== undefined);
  if (film.length === 0 && running.length === 0) return h('section', { class: 'vz-lane' }, h('h5', {}, 'Film'), h('p', { class: 'empty' }, 'No window of film read yet.'));
  const end = Math.max(1, ...film.map((look) => look.toS ?? look.fromS ?? 0), ...running.map((read) => read.toS ?? read.fromS ?? 0));
  const cellOf = (s: number) => Math.max(0, Math.min(VISION_CELLS - 1, Math.floor((s / end) * VISION_CELLS)));
  const cells = Array.from({ length: VISION_CELLS }, () => new Set<string>());
  const mark = (from: number | undefined, to: number | undefined, flag: string) => { for (let at = cellOf(from ?? 0); at <= cellOf(to ?? from ?? 0); at += 1) cells[at]!.add(flag); };
  for (const look of film) mark(look.fromS, look.toS, look.status === 'ok' ? 'read' : 'missed');
  for (const read of running) mark(read.fromS, read.toS, 'reading');
  if (chosen && visionLane(chosen) === 'film') mark(chosen.fromS, chosen.toS, 'cited');
  const shown = chosen && visionLane(chosen) === 'film' ? chosen : film.findLast((look) => look.status === 'ok');
  const source = shown?.item ?? shown?.source ?? film[0]?.item ?? film[0]?.source ?? 'the film';
  return h('section', { class: 'vz-lane' },
    h('h5', {}, `Film · ${source} · ${film.length} window${film.length === 1 ? '' : 's'} read`),
    h('div', { class: 'vz-cells', title: `0 to ${end} s; shaded: read; hatched: reading now` }, ...cells.map((flags) => h('span', { class: `vz-cell ${[...flags].join(' ')}`.trim() }))),
    shown !== undefined && shown.images.length > 0 && shown.images.every((image) => image.keyframe !== undefined) && h('p', { class: 'vz-note' }, 'The chapter\'s keyframe, not what the eyes saw: they looked at the window itself.'),
    shown && h('div', { class: 'vz-strip' }, ...(shown.images.length ? shown.images : [undefined]).map((image, at) => h('figure', {},
      visionPicture(image, `${source} ${shown.fragment}`, 'vz-frame'),
      h('figcaption', {}, image?.keyframe !== undefined ? `keyframe: ${image.keyframe}` : image?.at !== undefined ? `${image.at} s` : image?.caption ?? (at === 0 ? `#${shown.fragment}` : ''))))),
    shown && visionSaid(`#${shown.fragment}`, shown.body));
}

function visionPages(looks: VisionLook[], state: VisionState, chosen: VisionLook | undefined, boxes: { x: number; y: number; w: number; h: number }[]): Node {
  const pages = visionOnce(looks.filter((look) => visionLane(look) === 'pages'));
  const running = Object.values(state.running).filter((read) => read.page !== undefined);
  if (pages.length === 0 && running.length === 0) return h('section', { class: 'vz-lane' }, h('h5', {}, 'Pages'), h('p', { class: 'empty' }, 'No page read yet.'));
  const shown = chosen && visionLane(chosen) === 'pages' ? chosen : pages.findLast((look) => look.status === 'ok') ?? pages.at(-1);
  const read = new Set(pages.filter((look) => look.status === 'ok').map((look) => look.page));
  const source = shown?.item ?? shown?.source ?? 'the scans';
  return h('section', { class: 'vz-lane' },
    h('h5', {}, `Pages · ${source} · ${read.size} page${read.size === 1 ? '' : 's'} read${running.length ? ` · reading p.${running.map((each) => each.page).join(', p.')}` : ''}`),
    shown && h('div', { class: 'vz-page' },
      visionPicture(shown.images[0], `${source} page ${shown.page ?? ''}`, 'vz-scan'),
      // A box is where the account says the line stands: the eyes' estimate, so it is drawn dashed.
      ...boxes.map((box) => h('span', { class: 'vz-box', title: `xywh=percent:${box.x},${box.y},${box.w},${box.h}`, box }))),
    shown && visionSaid(`p.${shown.page ?? '?'}${shown.status === 'failed' ? ' (missed)' : ''}`, shown.body));
}

function visionPhotos(looks: VisionLook[], chosen: VisionLook | undefined, account: VisionAccount | undefined, focus: string | undefined): Node {
  const photos = visionOnce(looks.filter((look) => visionLane(look) === 'photos'));
  if (photos.length === 0) return h('section', { class: 'vz-lane' }, h('h5', {}, 'Photographs'), h('p', { class: 'empty' }, 'No photograph looked at yet.'));
  const labels = new Map((account?.photos ?? []).map((photo) => [photo.receipt ?? photo.item, photo]));
  const classes = [...new Set((account?.photos ?? []).map((photo) => photo.label))].sort();
  const labelled = photos.filter((look) => labels.has(look.key) || (look.item !== undefined && labels.has(look.item))).length;
  return h('section', { class: 'vz-lane' },
    h('h5', {}, `Photographs · ${photos.length} looked at${account ? ` · ${labelled} sorted` : ''}`),
    h('div', { class: 'vz-photos' }, ...photos.map((look) => {
      const photo = labels.get(look.key) ?? (look.item !== undefined ? labels.get(look.item) : undefined);
      const verdict = photo?.truth === undefined ? '' : photo.truth === photo.label ? ' right' : ' wrong';
      const dim = focus !== undefined && look.path !== undefined && !under(look.path, focus) ? ' dim' : '';
      return h('span', { class: `vz-tile${photo ? ` vz-c${classes.indexOf(photo.label) % 5}${verdict}` : ''}${chosen?.key === look.key ? ' cited' : ''}${look.status === 'failed' ? ' missed' : ''}${dim}`,
        title: `${look.item ?? (look.source || 'a look')}${photo ? `: ${photo.label}${photo.truth !== undefined ? ` (caption: ${photo.truth})` : ''}` : ''}${look.miss ? `: ${look.miss.code}${look.miss.reason ? `, ${look.miss.reason}` : ''}` : ''}`, ...(look.path ? { path: look.path } : {}) },
        visionPicture(look.images[0], look.item ?? look.source, 'vz-thumb', true), photo ? h('span', { class: 'vz-label' }, photo.label)
          // A miss is labelled by its code: a tile with no picture says why.
          : look.status === 'failed' && h('span', { class: 'vz-label' }, look.miss?.code.replaceAll('_', ' ') ?? 'missed'));
    })));
}

/** A typed time and how the eyes read it: the typed one's digits the reading dropped are struck. */
function visionStamp(miss: VisionTimes['misread'][number], cite: string | undefined): Node {
  const kept = miss.truth !== undefined ? visionKeptChars(miss.truth, miss.read) : [];
  return h('div', { class: 'vz-stamp' },
    h('span', { class: `vz-cite${miss.receipt === cite ? ' hot' : ''}`, ...(miss.receipt ? { cite: miss.receipt } : {}), title: 'the look that read it' }, `p.${miss.page}`),
    miss.truth !== undefined && h('code', { title: 'as typed' }, ...[...miss.truth].map((char, at) => (kept[at] ? char : h('s', { class: 'vz-drop', title: 'dropped' }, char)))),
    h('code', { class: 'vz-read', title: 'as the eyes read it' }, miss.read || '(nothing)'));
}

function visionTimesView(title: string, times: VisionTimes, cite: string | undefined, note = ''): Node {
  return h('div', { class: 'vz-weak' },
    h('h5', {}, title),
    note !== '' && h('p', { class: 'vz-note' }, note),
    h('p', {}, h('b', {}, `${times.inTyped} of ${times.times}`), ` times read off ${times.pages} page${times.pages === 1 ? '' : 's'} are in the typed transcript · ${times.unreadable} unreadable · ${times.misread.length} not in it`),
    times.misread.some((miss) => miss.truth !== undefined) && h('p', { class: 'vz-note' }, 'Each misread as typed, then as read: a struck digit was dropped.'),
    ...times.misread.map((miss) => visionStamp(miss, cite)));
}

function visionAccountView(account: VisionAccount, cite: string | undefined, eyes: string | undefined): Node[] {
  return [
    h('div', { class: 'vz-account' },
      ...account.entries.map((entry) => h('p', { class: `vz-entry${entry.cites.some((each) => each.receipt === cite) ? ' cited' : ''}` },
        h('span', { class: 'vz-time' }, entry.time), ` ${entry.text} `,
        ...entry.cites.map((each) => h('span', { class: `vz-cite${each.receipt === cite ? ' hot' : ''}`, cite: each.receipt, title: `${each.item}#${each.fragment.replace(/^#/, '')}` }, visionChipText(each.fragment)))))),
    account.dropped.length > 0 && h('p', { class: 'vz-note' }, `Left out of the account, ${account.dropped.length}: ${account.dropped.join('; ')}.`),
    account.times && visionTimesView(`Times read off the pages${eyes ? ` by ${eyes}` : ''}`, account.times, cite),
    account.weak && visionTimesView(`The same pages through ${account.weak.model}`, account.weak.times, cite,
      `${account.weak.photos ? `Its photo sort: ${account.weak.photos.right} of ${account.weak.photos.total}. ` : ''}${account.weak.source ? `Recorded as its own run, ${account.weak.source}.` : ''}`),
  ].filter((node): node is Node => node !== false && node !== undefined);
}

/** A cited result's rows, one a line: its label, its value, its note, and a chip per cite: a look's opens its receipt
 *  and moves its lane, a file's opens the file, a page known only by its address is linked. A row that cites nothing
 *  says so. */
function visionCitedView(cited: VisionCitedResult, cite: string | undefined, isImage: (sha: string) => boolean): Node {
  const chip = (each: VisionCitedRow['cites'][number], label: string): Node[] => {
    const words = each.fragment ? visionChipText(each.fragment) : each.look ? 'look' : each.blob ? 'file' : 'page';
    const about = [each.note, each.url, each.at].filter(Boolean).join(' · ');
    return [
      ...(each.look ? [h('span', { class: `vz-cite${each.look === cite ? ' hot' : ''}`, cite: each.look, title: about || 'the look that read it' }, words)] : []),
      // A picture in the recording is drawn small in its row; any other file is a link to it.
      ...(each.blob && isImage(each.blob) ? [h('span', { class: 'vz-keyframes', title: about || label }, { tag: 'img', blob: each.blob, alt: label, class: 'vz-keyframe' })] : []),
      ...(each.blob && !isImage(each.blob) ? [h('span', { ...(about ? { title: about } : {}) }, { tag: 'a', blob: each.blob, text: each.look ? 'file' : words, class: 'vz-cite', ...(each.fragment ? { fragment: each.fragment } : {}) })] : []),
      // A page named only by its address was not kept in the recording: it is linked, and says so.
      ...(!each.look && !each.blob && each.url ? [h('span', { ...(about ? { title: about } : {}) }, { tag: 'a', href: each.url, text: words, class: 'vz-cite' }, h('span', { class: 'vz-note' }, ' not kept'))] : []),
    ];
  };
  return h('div', { class: 'vz-account' },
    ...cited.rows.map((row) => h('p', { class: `vz-entry${row.cites.some((each) => each.look !== undefined && each.look === cite) ? ' cited' : ''}` },
      h('span', { class: 'vz-name' }, row.label), ' ', h('b', {}, row.value), row.note !== undefined && h('span', { class: 'vz-note' }, ` · ${row.note}`), ' ',
      ...(row.cites.length ? row.cites.flatMap((each) => chip(each, row.label)) : [h('span', { class: 'vz-note' }, 'cites nothing')]))));
}

/** The files a view draws as pictures: stills only (never an SVG, whose drawing is a document). */
const VISION_PICTURES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** The keyframes a cited result pairs with each look: the pictures a row cites beside that look, labelled with the row. */
const visionKeyframes = (cited: VisionCitedResult | undefined, isImage: (sha: string) => boolean): Map<string, VisionImage[]> => {
  const paired = new Map<string, VisionImage[]>();
  for (const row of cited?.rows ?? []) {
    const pictures = row.cites.flatMap((each) => (each.blob && isImage(each.blob) ? [each.blob] : []));
    for (const each of row.cites) {
      if (!each.look) continue;
      const held = paired.get(each.look) ?? [];
      paired.set(each.look, [...held, ...pictures.filter((blob) => !held.some((image) => image.blob === blob)).map((blob) => ({ blob, keyframe: row.label }))]);
    }
  }
  return new Map([...paired].filter(([, images]) => images.length > 0));
};

function visionAccuracyView(accuracy: NonNullable<VisionAccount['accuracy']>): Node {
  return h('div', { class: 'vz-accuracy' },
    h('h5', {}, 'Photo sort against the captions'),
    h('p', {}, h('b', {}, `${accuracy.overall.total ? Math.round((accuracy.overall.right / accuracy.overall.total) * 1000) / 10 : 0}%`), ` overall, ${accuracy.overall.right} of ${accuracy.overall.total}`),
    h('ul', {}, ...accuracy.byClass.map(([name, tally]) => h('li', {}, `${name}: ${tally.right} of ${tally.total}`))));
}

function visionReceipt(look: VisionLook, chosen: boolean): Node {
  const row = (name: string, value: string | undefined): Node | false => value !== undefined && value !== '' && h('div', { class: 'vz-row' }, h('span', { class: 'k' }, name), h('span', {}, value));
  return h('div', { class: `vz-receipt${look.status === 'failed' ? ' missed' : ''}` },
    h('h5', {}, `${chosen ? 'Receipt' : 'Latest look'} · ${look.item ?? look.source}${look.fragment ? ` #${look.fragment}` : ''}`),
    row('sha256', visionShort(look.sha256)), row('ask', look.ask), row(look.status === 'ok' ? 'answer' : 'missed', look.status === 'ok' ? look.body : look.miss ? `${look.miss.code}${look.miss.reason ? `: ${look.miss.reason}` : ''}` : look.body || 'code not recorded'),
    row('model', look.model), row('tokens', look.tokensIn !== undefined || look.tokensOut !== undefined ? `${look.tokensIn ?? '?'} in, ${look.tokensOut ?? '?'} out` : undefined),
    row('price', look.native ? 'in the lead\'s usage' : look.kept ? `${visionMoney(look.cost)} paid once, before the kill; this filing paid $0` : visionMoney(look.cost)),
    row('kept', look.kept ? 'yes: read back from the memo after a kill' : undefined),
    row('filed', `${look.receipt ?? 'no receipt path'} · generation ${look.gen}${look.lost ? ' · lost branch' : ''}`));
}

function visionMetersView(state: VisionState, meters: VisionMeters, following = false): Node {
  const row = (name: string, value: string, title: string, extra = ''): Node => h('div', { class: `vz-meter${extra}`, title }, h('span', {}, name), h('b', {}, value));
  const measured = state.visionLines > 0;
  const stored = (name: string, value: string, title: string, extra = '') => row(name, measured ? value : 'not measured', measured ? title : 'No vision document line in this recording: nothing here can be counted.', extra);
  return h('div', { class: 'vz-meters' },
    stored('looks paid', String(meters.paid), 'Per look key: each answer the eyes filed that is not kept, and once a key whose first answer is kept (paid by a process that died before filing it).'),
    stored('kept after a kill', String(meters.kept), 'Answers read back from the call\'s memo in a later attempt: no new payment.'),
    stored('repeated', String(meters.repeated), 'A look key paid again in a later generation.', meters.repeated > 0 ? ' alarm' : ' zero'),
    meters.askedTwice > 0 && stored('asked twice', String(meters.askedTwice), 'A look key paid twice in one generation.', ' alarm'),
    row('possible extra payments', `${meters.possible} (observed)`, 'From live lines: a look started in a process that ended without filing it. Its eyes may have answered and been paid; no durable line says.', meters.possible > 0 ? ' alarm' : ''),
    stored('spend', measured ? `${meters.possible > 0 && meters.cost !== null ? 'at least ' : ''}${visionMoney(meters.cost)}` : 'unknown',
      following ? 'A run followed while it goes: its spend is known once it finishes.'
        : `Once per payment, with each failed look's own price; unknown when any is unknown.${meters.possible > 0 ? ' A lower bound: a possible payment is not in it.' : ''}`),
    stored('typed misses', meters.failed === 0 ? '0' : `${meters.failed}: ${meters.misses.map(([code, n]) => `${code} ${n}`).join(', ')}`, 'Failed LookRecords, by miss code.'));
}

function visionView(state: VisionState, context: ViewContext): Node {
  const meters = visionMeters(state);
  const resultValue = state.result ? context.json?.(state.result.blob) : undefined;
  const parsed = state.result && resultValue !== undefined ? visionAccountOf(resultValue) : undefined;
  const account = typeof parsed === 'object' ? parsed : undefined;
  const cited = account ? undefined : visionCitedOf(resultValue);
  // A cited result shows with no look at all: its rows may cite only files, or nothing.
  const looked = state.looks.length > 0 || Object.keys(state.running).length > 0;
  if (!looked && !cited) return h('div', { class: 'vz' }, h('p', { class: 'empty' }, 'The eyes have not looked at anything yet.'));
  const kept = meters.kept;
  // A look's pictures: those its filing names, else those its read showed, else, for a window of film, the keyframes a
  // cited row pairs with it (marked as such: the eyes saw the window, not a still). A page keeps its own scan: the boxes
  // a cite draws are on that page.
  const isImage = (sha: string) => VISION_PICTURES.has(context.blobType?.(sha)?.split(';')[0]!.trim().toLowerCase() ?? '');
  const keyframes = visionKeyframes(cited, isImage);
  const pictured = (look: VisionLook): VisionLook => (look.images.length ? look
    : { ...look, images: state.shown[visionShownKey(look.conv, look.source, look.page, look.fromS, look.toS)] ?? (visionLane(look) === 'film' ? keyframes.get(look.key) : undefined) ?? [] });
  const named = visionCited(state, context.cite);
  const chosen = named && pictured(named);
  // A box is where a cite of the chosen look says the line stands: the account's or a cited result's fragments.
  const fragments = [...(account?.entries.flatMap((entry) => entry.cites).map((each) => ({ look: each.receipt, fragment: each.fragment })) ?? []),
    ...(cited?.rows.flatMap((row) => row.cites).map((each) => ({ look: each.look, fragment: each.fragment })) ?? [])];
  // Only the pages lane draws boxes, so only a chosen page has them.
  const boxes = chosen && visionLane(chosen) === 'pages' ? fragments.filter((each) => each.look === chosen.key).flatMap((each) => { const box = visionRegion(each.fragment); return box ? [box] : []; }) : [];
  // The lanes draw the run's own eyes; a weaker model the account compares them with is drawn in its own scene.
  const lanes = state.looks.filter((look) => !look.native && look.model !== account?.weak?.model).map(pictured);
  const shown = chosen ?? lanes.at(-1);
  return h('div', { class: 'vz' },
    h('div', { class: 'vz-top' },
      state.lead && h('span', { class: 'vz-badge' }, `lead: ${state.lead}`),
      meters.native === 0 && state.looks.length > 0 && h('span', { class: 'vz-badge' }, 'the lead never sees an image'),
      meters.eyes.length > 0 && h('span', { class: 'vz-badge' }, `eyes: ${meters.eyes.join(', ')}`),
      state.kills.length > 0 && h('span', { class: 'vz-badge red' }, `killed ${state.kills.length === 1 ? 'once' : `${state.kills.length} times`}${state.kills.at(-1)?.label ? `: ${state.kills.at(-1)!.label}` : ''}`),
      kept > 0 && h('span', { class: 'vz-badge ok' }, `resumed · ${kept} kept`)),
    h('div', { class: 'vz-grid' },
      h('div', { class: 'vz-col' }, visionFilm(lanes, state, chosen), visionPages(lanes, state, chosen, boxes), visionPhotos(lanes, chosen, account, context.focus)),
      h('div', { class: 'vz-col' },
        h('h5', {}, cited ? cited.title ?? state.result?.title ?? 'The result' : 'The account'),
        !state.result ? h('p', { class: 'empty' }, 'Not delivered yet.')
          : account ? h('div', {}, ...visionAccountView(account, context.cite, meters.eyes.find((model) => model !== account.weak?.model)))
            : cited ? visionCitedView(cited, context.cite, isImage)
              : h('p', { class: 'empty' }, typeof parsed === 'string' ? `${parsed}: ` : 'The account is in the result: ', { tag: 'a', blob: state.result.blob, text: state.result.title })),
      h('div', { class: 'vz-col' },
        h('h5', {}, 'Meters'), visionMetersView(state, context.following ? { ...meters, cost: null } : meters, context.following === true),
        account?.accuracy && visionAccuracyView(account.accuracy),
        shown && visionReceipt(shown, chosen !== undefined),
        context.cite !== undefined && !chosen && h('p', { class: 'empty' }, 'The look this citation names is not filed at this point.'),
        (Object.keys(state.running).length > 0 || Object.keys(state.told).length > 0) && h('div', { class: 'vz-flight' },
          h('h5', {}, 'In flight (live lines)'),
          h('ul', {}, ...Object.values(state.running).map((read) => h('li', {}, `reading ${read.source}${read.page !== undefined ? ` p.${read.page}` : ''}${read.fromS !== undefined ? ` ${read.fromS}-${read.toS ?? ''} s` : ''}`)),
            ...Object.values(state.told).map((told) => h('li', {}, `${told.what === 'look' ? `the eyes answered for ${told.source}${told.fragment ? ` #${told.fragment}` : ''}` : `a miss (${told.code}) on ${told.source}`}${told.receipt ? ', not filed yet' : ', with no receipt'}`)))))));
}

export const visionPanel: Panel<VisionState> = {
  id: 'vision',
  title: 'What the eyes read',
  init: visionInit,
  accepts: (line) => visionKnown(line) || counterFold.accepts(line),
  reduce: visionReduce,
  view: visionView,
};

register(visionPanel);
