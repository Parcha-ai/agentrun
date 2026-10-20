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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

/** One labeller for a process's boxes: `box-N` by first appearance, kept with each box's provider and id in `file` (outside the recording), so the next process of the run
 *  numbers on past them and a person can find a box a run left. The file is read at the first label, never before: a run on a disk not yet mounted has nothing to read. Without
 *  a file the labels live only in this process. Receipts: a box `open`ed here is `end`ed or, at `finish`, written as still open. */
export type BoxLedger = {
  label(provider: string, id: string): string;
  open(label: string, receipt: { provider: string; kind: string; from: string }): void;
  end(label: string): void;
  /** Every receipt of a box still open: written when the process is done with the run. */
  finish(): void;
};

export function boxLedger(options: { file?: string; recorder?: Recorder } = {}): BoxLedger {
  let ids: Record<string, { provider: string; id: string }> | undefined;
  const read = () => {
    if (ids) return ids;
    try { ids = options.file ? (JSON.parse(readFileSync(options.file, 'utf8')) as Record<string, { provider: string; id: string }>) : {}; } catch { ids = {}; }
    return ids;
  };
  const open = new Map<string, { provider: string; kind: string; from: string }>();
  const receipt = (label: string, made: { provider: string; kind: string; from: string }, to: string | null) => {
    try {
      options.recorder?.host('box.receipt', { box: label, provider: made.provider, kind: made.kind, from: made.from, to, seconds: to === null ? null : Math.max(0, (Date.parse(to) - Date.parse(made.from)) / 1000), usd_per_second: null, cost_usd: null, source: null, priced: null });
    } catch { /* a recording line never fails a call */ }
  };
  return {
    label(provider, id) {
      const known = read();
      const had = Object.entries(known).find(([, entry]) => entry.provider === provider && entry.id === id)?.[0];
      if (had) return had;
      const label = `box-${Math.max(0, ...Object.keys(known).map((each) => Number(/^box-(\d+)$/.exec(each)?.[1] ?? 0))) + 1}`;
      known[label] = { provider, id };
      if (options.file) {
        mkdirSync(dirname(options.file), { recursive: true });
        const temporary = `${options.file}.tmp-${process.pid}`;
        writeFileSync(temporary, `${JSON.stringify(known, null, 2)}\n`);
        renameSync(temporary, options.file);
      }
      return label;
    },
    open(label, made) { open.set(label, made); },
    end(label) {
      const made = open.get(label);
      if (!made) return;
      open.delete(label);
      receipt(label, made, new Date().toISOString());
    },
    finish() {
      for (const [label, made] of open) receipt(label, made, null);
      open.clear();
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
      return found.ok && found.value ? { ok: true, value: wrap(found.value, ledger.label(provider.name, found.value.id)).box } as typeof found : found;
    },
    create: async (spec, context) => {
      const lostAtCreate = taken('transport.box.create');
      const made = await provider.create(labelled(spec), context);
      if (!made.ok) return made;
      const label = ledger.label(provider.name, made.value.id);
      const facts = made.value.facts();
      const role = spec.labels?.role;
      line('box.created', { box: label, provider: provider.name, facts: { isolation: facts.isolation, cpus: facts.cpus, gpu: facts.gpu }, ...(role ? { role } : {}) });
      if (options.receipts) ledger.open(label, { provider: provider.name, kind: facts.gpu !== null ? `gpu:${facts.gpu}` : facts.isolation, from: new Date().toISOString() });
      const wrapped = wrap(made.value, label);
      // The box a planned loss at the create crossing was about to make is made and lost at once; `created` is the next crossing. Each is recorded as a loss.
      if (lostAtCreate) await wrapped.lose('transport.box.create');
      else if (taken('transport.box.created')) await wrapped.lose('transport.box.created');
      return { ok: true, value: wrapped.box } as typeof made;
    },
  };
  return tapped;
}
