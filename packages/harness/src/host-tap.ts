// A place's host boxes through the supervisor's tap (H3; RECORDING.md draft 56 with its Amendment 1). A place whose host driver
// makes boxes (disk's `boxHost`) gets the provider it makes them with from here, tapped, and calls `unheld` in each start's unheld
// window, before that start's box is made. Each host box's life then reaches the recording as the supervisor's own host lines:
//   box.created { gen, box, provider, facts: { isolation, cpus, gpu }, role: 'host', from }
//   box.exec    { gen, box }, and `at` on one held before the bind: one per command the box took, never the command, its arguments or its environment
//   box.ended   { gen, box, provider, killed }
// `gen` is the process whose start made the box, `box` its run-wide label. The label is BOUND by the run's process once it holds
// the run (H1's claimHost, link(2) on its mount), after the box exists, so the lines wait here until the supervisor READS the bound
// label over the place's run-file reads (`bound`): then `box.created` (with `from`, when the box was made) and each held `box.exec`
// (with `at`, when its command ran) are written in order. A recording never carries a pending name, and a host box whose label
// never binds is refused at the final read (H1). The window writes only a name of its own start's (`pending/<life>-<attempt>.json`),
// never a label: a put is not exclusive across two supervisor lives, a link on the holder's mount is.
import type { Box, BoxProvider } from '@parcha/pi-transport';
import type { HostTap, UnheldRun, UnheldStart } from './place.ts';

type HostBoxKind = 'box.created' | 'box.exec' | 'box.ended';
type HostBox = { key: string; provider: string; gen: number; label?: string; held: { kind: HostBoxKind; data: Record<string, unknown> }[]; ended: boolean };

/** pi-transport's `BoxError` shape, without a runtime import of the optional peer. */
const boxError = (code: 'invalid' | 'unknown', message: string) => Object.assign(new Error(message), { name: 'BoxError', code });
const PLAIN = /^[A-Za-z0-9._-]+$/;

export function hostTap(options: {
  /** The supervisor's host line writer. */ line(kind: HostBoxKind, data: Record<string, unknown>): void;
  /** The run's unique label value, put on every host box as on every box the run makes. */ runLabelKey?: string; runLabel?: string;
}): HostTap & {
  /** The supervisor READ host box `key`'s bound label: its held lines are written now, and its later ones at once. */ bound(key: string, label: string): void;
  /** The supervisor is about to take attempt `gen`'s box away (a kill of kind box): that box's end is a kill. */ killing(gen: number): void;
} {
  /** The start whose unheld window ran and whose box is not made yet. */
  let pending: { provider: string; key: string; gen: number } | undefined;
  const byKey = new Map<string, HostBox>();
  const byId = new Map<string, HostBox>();
  const killing = new Set<number>();
  const now = () => new Date().toISOString();
  const write = (box: HostBox, kind: HostBoxKind, data: Record<string, unknown>) => {
    if (box.label === undefined) { box.held.push({ kind, data }); return; }
    try { options.line(kind, { gen: box.gen, box: box.label, ...data }); } catch { /* a recording line never fails a call */ }
  };
  const track = (id: string, start: { provider: string; key: string; gen: number }): HostBox => {
    const box: HostBox = { key: start.key, provider: start.provider, gen: start.gen, held: [], ended: false };
    byKey.set(start.key, box);
    byId.set(id, box);
    return box;
  };
  const created = (box: HostBox, made: Box, from: string) => {
    const facts = made.facts();
    write(box, 'box.created', { provider: box.provider, facts: { isolation: facts.isolation, cpus: facts.cpus, gpu: facts.gpu }, role: 'host', from });
  };
  const end = (box: HostBox) => {
    if (box.ended) return;
    box.ended = true;
    write(box, 'box.ended', { provider: box.provider, killed: killing.has(box.gen) });
  };
  const wrap = (made: Box, box: HostBox): Box => new Proxy(made, { get(target, name) {
    const member = Reflect.get(target, name, target);
    if (name === 'exec') {
      return async (...args: unknown[]) => {
        const at = now();
        // Whether the command BEGAN before the bind is decided now: one whose answer comes after the bind keeps its own time too.
        const held = box.label === undefined;
        const started = await (member as Box['exec']).apply(target, args as Parameters<Box['exec']>);
        // A command begun before the bind keeps its own time (`at`); one begun after it is written at once, with none.
        if (started.ok) write(box, 'box.exec', held ? { at } : {});
        return started;
      };
    }
    if (name === 'status') {
      return async (...args: unknown[]) => {
        const read = await (member as Box['status']).apply(target, args as Parameters<Box['status']>);
        if (read.ok && read.value.state === 'ended') end(box);
        return read;
      };
    }
    if (name === 'destroy') {
      return async (...args: unknown[]) => {
        const result = await (member as Box['destroy']).apply(target, args as Parameters<Box['destroy']>);
        if (result.ok) end(box);
        return result;
      };
    }
    return typeof member === 'function' ? member.bind(target) : member;
  } });

  return {
    async unheld(run: UnheldRun, start: UnheldStart): Promise<void> {
      if (start.box === undefined) throw new Error('this start hands the run\'s process no host box (HOST_BOX), so the box it makes could never be labelled: the host tap refuses it (pass `unheld` only with the tapped provider)');
      const { provider, key, run: life } = start.box;
      if (!PLAIN.test(life) || !Number.isInteger(start.attempt) || start.attempt < 1) throw new Error('this start\'s run or attempt is not a plain name');
      // A name of this start's own, never a label: the holder binds the label (claimHost, link(2) on its mount), where one writer wins.
      const path = `box-ids.internal/pending/${life}-${start.attempt}.json`;
      const text = `${JSON.stringify({ provider, key, run: life })}\n`;
      try {
        await run.put(path, text);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'EXISTS') throw error;
        // A retried start (a takeover, a driver adopting its own box) wrote it before: the same entry, or refused.
        const back = await run.read(path);
        if (back === null || Buffer.from(back).toString('utf8') !== text) throw new Error(`the pending entry of start ${start.attempt} holds another box: refused`);
      }
      pending = { provider, key, gen: start.attempt };
    },
    provider<P extends { readonly name: string }>(given: P): P {
      const provider = given as unknown as BoxProvider;
      const labelled = <S extends { labels?: Readonly<Record<string, string>> }>(spec: S): S => (options.runLabelKey && options.runLabel ? { ...spec, labels: { ...spec.labels, [options.runLabelKey]: options.runLabel } } : spec);
      const tapped: BoxProvider = {
        name: provider.name,
        list: (labels, context) => provider.list(labels, context),
        create: async (spec, context) => {
          const start = pending;
          // FAIL CLOSED: a host box no unheld window announced could never be labelled; it is refused before any box is made.
          if (start === undefined || start.provider !== provider.name) return { ok: false, error: boxError('invalid', `a host box made outside the place's unheld window has no label: refused before any box is made`) } as never;
          const from = now();
          const made = await provider.create(labelled(spec), context);
          // A create that failed keeps the start pending: a box it made anyway is found by the place's list and attached.
          if (!made.ok) return made;
          pending = undefined;
          const box = track(made.value.id, start);
          created(box, made.value, from);
          return { ok: true, value: wrap(made.value, box) } as typeof made;
        },
        attach: async (id, context) => {
          const found = await provider.attach(id, context);
          if (!found.ok || !found.value) return found;
          let box = byId.get(id);
          if (box === undefined) {
            const start = pending;
            // A box no window of this life announced is not this life's to record (an earlier life's, read for its status).
            if (start === undefined || start.provider !== provider.name) return found;
            pending = undefined;
            box = track(id, start);
            created(box, found.value, now());
          }
          return { ok: true, value: wrap(found.value, box) } as typeof found;
        },
      };
      return tapped as unknown as P;
    },
    bound(key: string, label: string): void {
      const box = byKey.get(key);
      if (box === undefined || box.label !== undefined) return;
      box.label = label;
      for (const { kind, data } of box.held.splice(0)) write(box, kind, data);
    },
    killing(gen: number): void { killing.add(gen); },
  };
}
