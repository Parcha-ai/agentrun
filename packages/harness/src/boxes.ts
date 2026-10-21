// The boxes capability: a pi-transport `BoxProvider` the entry hands a demo (to its tools as `context.boxes`, and to the job's own tools through `boxEnv`), and the providers a
// demo brings for its tools' own boxes (`DemoOptions.providers`, handed to the tools as `context.providers`), each with the crossings and the transport box lines of the run built
// in. A demo never writes either.
//
// The crossings (a demo's `kills[].point` names them; `n` picks the nth time):
//   transport.box.create    a box is about to be made
//   transport.box.created   a box exists and is not yet used
//   transport.box.exec      a box command is in flight: started, its answer not yet read. The crossing the audit demo's install kill names
//   transport.box.destroy   a box is about to be destroyed
// A crossing taken inside a tool call (between its dispatch and the host keeping its answer) is never a `target: "run"` kill point: a kill there leaves that call
// unknown. It can still be a `target: "tool"` kill: the box taken in the crossing is destroyed once, the run's process lives, and no kill line is written.
//
// The transport lines (live lines, source `transport`; RECORDING.md draft 39), each naming its box by its label (`box-1`, `box-2` by first appearance), never by the provider's id:
// `box.created` { box, provider, facts: { isolation, cpus, gpu }, role? }, `box.exec` { box } (one per command the box took; never the command, its arguments or its environment),
// `box.killed` { box, crossing } (a planned loss, written before the box is destroyed), `box.ended` { box, provider, killed } (the box is gone, however it ended). A box of the
// demo's providers also gets a host `box.receipt` when it ends, or when the process ends with it still open; with no rate it says so (`usd_per_second`, `cost_usd`, `source` and
// `priced` null), so the run's cost reads unknown, never 0. The provider ids go only to the ledger's file, outside the recording.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Box, BoxProvider } from '@parcha/pi-transport';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { Cross, EffectWindow } from './crossings.ts';
import type { Recorder } from './record.ts';

/** The boxes a demo's tools get (`context.boxes`, `context.providers`): a pi-transport `BoxProvider` at run time. pi-transport is an optional
 *  peer, so this package's types name only what every provider has; a tool that makes boxes types them with pi-transport's own `BoxProvider`.
 *  A box a tapped provider makes carries its `label` (`box-N`): what a tool's result names, so the results and the lines agree. */
export type Boxes = { readonly name: string };

export const BOX_CROSSINGS = ['transport.box.create', 'transport.box.created', 'transport.box.exec', 'transport.box.destroy'] as const;

/** The label every box of a run carries, so one run's cleanup finds its own boxes and no other run's. */
export const RUN_LABEL = 'agentrun-run';

/** pi-transport's `BoxError` shape (`code` `unknown`), without a runtime import of the optional peer. */
const boxError = (message: string) => Object.assign(new Error(message), { name: 'BoxError', code: 'unknown' as const });

/** A box's line in the run's ids directory (format v1): a tool's box by its provider id, with its receipt state. */
export type LedgerEntry = { provider: string; owner: 'tools'; id: string; kind?: string; from?: string; receipt?: 'open' | 'written' };

const LABEL_FILE = /^box-(\d+)\.json$/;
/** A refusal of the ids directory's own: passed on as it is, never wrapped as a write failure. */
class Refusal extends Error {}
const refused = (what: string, error: unknown) => new Refusal(`${what} (${(error as Error).message}): refused, so no box label is given twice`);

/** The ids directory of a run: one file per label (`box-N.json`), each claimed by `link(2)` from a temp file, so two writers never take one label; `EEXIST` means taken, and the
 *  claimer tries the next. Only the label's owner rewrites its file (for its receipt state). A file that cannot be read refuses; a disk that gives no exclusive link refuses. */
function labelStore(dir: string) {
  let ready = false;
  /** A path that is a file (a single ids file given as `--box-ids`), named as such wherever it is found: at a read (ENOTDIR) or at the first claim (EEXIST). */
  const aFile = () => { try { return statSync(dir).isFile() ? new Refusal(`the box ids path ${dir} is a file: --box-ids names a directory (one file per label); name a directory`) : undefined; } catch { return undefined; } };
  const temp = (entry: unknown) => {
    const path = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(path, 'wx');
    try { writeSync(fd, `${JSON.stringify(entry, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    return path;
  };
  const list = (): Map<string, LedgerEntry> => {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw ((error as NodeJS.ErrnoException).code === 'ENOTDIR' && aFile()) || refused(`the box ids directory ${dir} cannot be read`, error);
    }
    const out = new Map<string, LedgerEntry>();
    for (const name of names) {
      const number = LABEL_FILE.exec(name)?.[1];
      if (number === undefined) continue;
      let entry: LedgerEntry;
      try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as LedgerEntry; } catch (error) { throw refused(`the box ids file ${join(dir, name)} cannot be read`, error); }
      if (entry === null || typeof entry !== 'object' || typeof entry.provider !== 'string' || entry.owner !== 'tools' || typeof entry.id !== 'string') throw new Refusal(`the box ids file ${join(dir, name)} cannot be read (not a format v1 entry): refused, so no box label is given twice`);
      out.set(`box-${number}`, entry);
    }
    return out;
  };
  /** The disk must give an exclusive link: a second link to one name fails with EEXIST. */
  const probe = () => {
    const from = temp({ probe: true });
    const to = join(dir, `.probe-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      linkSync(from, to);
      let twice = true;
      try { linkSync(from, to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; twice = false; }
      if (twice) throw new Refusal(`the disk under ${dir} gives no exclusive link: refused, so no box label is given twice`);
    } finally { rmSync(from, { force: true }); rmSync(to, { force: true }); }
  };
  /** ENOENT on a create in a directory that exists: on an Archil mount, a directory made by path takes no files; a disk place makes it over its control. */
  const cannotTakeFiles = (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    try { if (!statSync(dir).isDirectory()) return undefined; } catch { return undefined; }
    return new Refusal(`${dir}/ cannot take files: on a disk place it must be made by the place, not by path (ENOENT on a directory that exists); refused, so no box label is given twice`);
  };
  const ensure = () => {
    if (ready) return;
    // `recursive`: a directory already there (a disk place makes it before the runner starts) is used as it is; the local place has none made, so it is made here.
    try { mkdirSync(dir, { recursive: true }); probe(); } catch (error) {
      const unusable = cannotTakeFiles(error);
      if (unusable) throw unusable;
      const file = (error as NodeJS.ErrnoException).code === 'EEXIST' ? aFile() : undefined;
      if (file) throw file;
      // A read-only mount (a shared Archil mount answers EROFS) is not the run's holder: only the process that holds the run claims its labels.
      if ((error as NodeJS.ErrnoException).code === 'EROFS') throw new Refusal(`the box ids directory ${dir} is not on the run's holder mount (EROFS, read-only): only the process that holds the run claims labels; refused, so no box label is given twice`);
      if (error instanceof Refusal) throw error;
      throw new Error(`the box ids directory ${dir} cannot be written (${(error as Error).message})`);
    }
    ready = true;
  };
  return {
    list,
    claim(entry: LedgerEntry): string {
      ensure();
      let from: string;
      try { from = temp(entry); } catch (error) { throw cannotTakeFiles(error) ?? new Error(`the box ids directory ${dir} cannot be written (${(error as Error).message})`); }
      try {
        for (let n = Math.max(0, ...[...list().keys()].map((label) => Number(label.slice(4)))) + 1; ; n += 1) {
          try { linkSync(from, join(dir, `box-${n}.json`)); return `box-${n}`; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`the box ids directory ${dir} cannot be written (${(error as Error).message})`);
          }
        }
      } finally { rmSync(from, { force: true }); }
    },
    rewrite(label: string, entry: LedgerEntry) {
      ensure();
      renameSync(temp(entry), join(dir, `${label}.json`));
    },
  };
}

/** The same store in this process's memory, for a ledger with no directory (a tap's own). */
function memoryStore() {
  const entries = new Map<string, LedgerEntry>();
  return {
    list: () => new Map(entries),
    claim(entry: LedgerEntry) { const label = `box-${entries.size + 1}`; entries.set(label, { ...entry }); return label; },
    rewrite(label: string, entry: LedgerEntry) { entries.set(label, { ...entry }); },
  };
}

/** One labeller for a run's tool boxes: `box-N` across every process of the run, each label a file of its own in `dir` (outside the recording), claimed exclusively. The
 *  directory is read at its first use, never before: a run on a disk not yet mounted has nothing to read. Without a directory the labels live only in this process. Receipts: a box `open`ed here is `end`ed or, at `finish`, written as still open; its state is kept in its file, so a process that
 *  starts after one was killed writes the receipt of each box that process left open (`recover`). */
export type BoxLedger = {
  label(provider: string, id: string): string;
  open(label: string, receipt: { provider: string; kind: string; from: string }): void;
  end(label: string): void;
  /** Every receipt of a box still open: written when the process is done with the run. */
  finish(): void;
  /** The receipts of boxes an earlier process opened and never closed (it was killed): written by the process that starts next, with `to` and `seconds` null. */
  recover(): void;
};

export function boxLedger(options: { dir?: string; recorder?: Recorder } = {}): BoxLedger {
  const store = options.dir ? labelStore(options.dir) : memoryStore();
  // The labels this process opened a receipt for.
  const opened = new Set<string>();
  const receipt = (label: string, entry: LedgerEntry, to: string | null) => {
    try {
      const from = entry.from ?? null;
      options.recorder?.host('box.receipt', { box: label, provider: entry.provider, kind: entry.kind ?? null, from, to, seconds: to === null || from === null ? null : Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000), usd_per_second: null, cost_usd: null, source: null, priced: null });
    } catch { /* a recording line never fails a call */ }
  };
  const close = (label: string, to: string | null) => {
    const entry = store.list().get(label);
    if (!entry || entry.receipt === 'written') return;
    receipt(label, entry, to);
    try { store.rewrite(label, { ...entry, receipt: 'written' }); } catch { /* the receipt is written; only a failed save lets a later process write it again */ }
  };
  return {
    label(provider, id) {
      const had = [...store.list()].find(([, entry]) => entry.owner === 'tools' && entry.provider === provider && entry.id === id)?.[0];
      return had ?? store.claim({ provider, owner: 'tools', id });
    },
    open(label, made) {
      const entry = store.list().get(label);
      if (!entry) return;
      store.rewrite(label, { ...entry, kind: made.kind, from: made.from, receipt: 'open' });
      opened.add(label);
    },
    end(label) {
      if (!opened.delete(label)) return;
      close(label, new Date().toISOString());
    },
    finish() {
      for (const label of [...opened]) { opened.delete(label); close(label, null); }
    },
    recover() {
      for (const [label, entry] of store.list()) if (entry.owner === 'tools' && entry.receipt === 'open' && !opened.has(label)) close(label, null);
    },
  };
}

export function tapBox(boxes: Boxes, options: {
  cross: Cross; window: EffectWindow; recorder?: Recorder;
  /** The run's unique label value: put on every box the run makes, tool-made ones too. */ runLabel?: string;
  /** The process's one labeller; a ledger of this tap's own without it. */ ledger?: BoxLedger;
  /** A receipt for each box this tap makes (the demo's providers' boxes). */ receipts?: boolean;
}): Boxes {
  const provider = boxes as BoxProvider;
  const { cross, recorder } = options;
  const ledger = options.ledger ?? boxLedger();
  const line = (kind: 'box.created' | 'box.exec' | 'box.killed' | 'box.ended', data: Record<string, unknown>) => { try { recorder?.live('transport', kind, data); } catch { /* a recording line never fails a call */ } };
  // A crossing in a tool call cannot end the run's process: it is logged, and it may still end the box (the crossing function says so when a tool-box kill is due).
  const taken = (point: string) => cross(point);
  const wrap = (box: Box, label: string): { box: Box; lose(point: string): Promise<{ ok: boolean }> } => {
    let ended = false;
    let killed = false;
    const end = () => { if (!ended) { ended = true; line('box.ended', { box: label, provider: provider.name, killed }); ledger.end(label); } };
    /** The planned loss of this box at a crossing: recorded first, then destroyed. A failed destroy is not an end: the failure is returned and the box is not recorded as gone. */
    const lose = async (point: string) => {
      killed = true;
      line('box.killed', { box: label, crossing: point });
      const result = await box.destroy(ctx);
      if (result.ok) end();
      return result;
    };
    const proxy = new Proxy(box, { get(target, name) {
      if (name === 'label') return label;
      const member = Reflect.get(target, name, target);
      if (name === 'exec') {
        return async (...args: unknown[]) => {
          const started = await (member as Box['exec']).apply(target, args as Parameters<Box['exec']>);
          // One line per command the box took, before its crossing: never the command, its arguments or its environment.
          if (started.ok) line('box.exec', { box: label });
          if (started.ok && taken('transport.box.exec')) await lose('transport.box.exec');
          return started;
        };
      }
      if (name === 'status') {
        return async (...args: unknown[]) => {
          const read = await (member as Box['status']).apply(target, args as Parameters<Box['status']>);
          if (read.ok && read.value.state === 'ended') end();
          return read;
        };
      }
      if (name === 'destroy') {
        return async (...args: unknown[]) => {
          // A planned loss at the destroy crossing: the box is lost, not ended normally.
          if (!killed && taken('transport.box.destroy')) { killed = true; line('box.killed', { box: label, crossing: 'transport.box.destroy' }); }
          const result = await (member as Box['destroy']).apply(target, args as Parameters<Box['destroy']>);
          if (result.ok) end();
          return result;
        };
      }
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    return { box: proxy, lose };
  };
  const labelled = <S extends { labels?: Readonly<Record<string, string>> }>(spec: S): S => (options.runLabel ? { ...spec, labels: { ...spec.labels, [RUN_LABEL]: options.runLabel } } : spec);
  const tapped: BoxProvider = {
    name: provider.name,
    list: (labels, context) => provider.list(labels, context),
    // A box a tool reconnects to is the run's too: it is wrapped, so its commands are crossings and its life is on the recording, under the label it already has.
    attach: async (id, context) => {
      const found = await provider.attach(id, context);
      if (!found.ok || !found.value) return found;
      let label: string;
      try { label = ledger.label(provider.name, found.value.id); } catch (error) { return { ok: false, error: boxError((error as Error).message) } as unknown as typeof found; }
      return { ok: true, value: wrap(found.value, label).box } as typeof found;
    },
    create: async (spec, context) => {
      const lostAtCreate = taken('transport.box.create');
      const made = await provider.create(labelled(spec), context);
      if (!made.ok) return made;
      const facts = made.value.facts();
      let label: string;
      try {
        label = ledger.label(provider.name, made.value.id);
        if (options.receipts) ledger.open(label, { provider: provider.name, kind: facts.gpu !== null ? `gpu:${facts.gpu}` : facts.isolation, from: new Date().toISOString() });
      } catch (error) {
        // A box whose label cannot be kept would run with no label and no receipt, and no cleanup knows it: it is destroyed, and the create fails.
        await made.value.destroy(ctx);
        return { ok: false, error: boxError((error as Error).message) } as unknown as typeof made;
      }
      const role = spec.labels?.role;
      line('box.created', { box: label, provider: provider.name, facts: { isolation: facts.isolation, cpus: facts.cpus, gpu: facts.gpu }, ...(role ? { role } : {}) });
      const wrapped = wrap(made.value, label);
      // The box a planned loss at the create crossing was about to make is made and lost at once; `created` is the next crossing. Each is recorded as a loss.
      if (lostAtCreate) await wrapped.lose('transport.box.create');
      else if (taken('transport.box.created')) await wrapped.lose('transport.box.created');
      return { ok: true, value: wrapped.box } as typeof made;
    },
  };
  return tapped;
}
