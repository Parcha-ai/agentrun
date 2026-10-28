// A place's host boxes through the supervisor's tap (H3; RECORDING.md draft 56 with its Amendment 1). A place whose host driver
// makes boxes (disk's `boxHost`) gets the provider it makes them with from here, tapped, and calls `unheld` in each start's unheld
// window, before that start's box is made. Each host box's life then reaches the recording as the supervisor's own host lines:
//   box.created { gen, box, provider, facts: { isolation, cpus, gpu }, role: 'host', from }
//   box.exec    { gen, box }, and `at` on one held before the bind: one per command the box took, never the command, its arguments or its environment
//   box.ended   { gen, box, provider, killed }
// On box.created, `gen` is the process whose start made the box; on box.exec and box.ended, the process during whose life the command
// ran or the box ended (Amendment 2): a box a later process adopted carries that process's gen on the lines it causes. `box` is its
// run-wide label. A host box carries its key, minted per box at its create by the place's host driver, as ONE provider label
// (`agentrun-host-key`, which the host driver writes and the tap only READS): the tap matches a box it attaches by that key, and a
// box without it is never taken as this run's host box (it passes through, unrecorded). The label is BOUND by the run's process once it holds
// the run (H1's claimHost, link(2) on its mount), after the box exists, so the lines wait here until the supervisor READS the bound
// label over the place's run-file reads (`bound`): then `box.created` (with `from`, when the box was made) and each held `box.exec`
// (with `at`, when its command ran) are written in order. A recording never carries a pending name, and a host box whose label
// never binds is refused at the final read (H1). The window writes only a name of its own start's (`pending/<life>-<attempt>.json`),
// never a label: a put is not exclusive across two supervisor lives, a link on the holder's mount is.
import type { Box, BoxProvider } from '@parcha/pi-transport';
import type { HostTap, UnheldRun, UnheldStart } from './place.ts';

type HostBoxKind = 'box.created' | 'box.exec' | 'box.ended';
type HostBox = { key: string; provider: string; gen: number; label?: string; held: { kind: HostBoxKind; data: Record<string, unknown>; gen: number }[]; ended: boolean; handle?: Box };

/** The provider label a host driver writes on each host box at its create: the box's key, minted per box (Amendment 2). */
export const HOST_KEY_LABEL = 'agentrun-host-key';

/** pi-transport's `BoxError` shape, without a runtime import of the optional peer. */
const boxError = (code: 'invalid' | 'unknown', message: string) => Object.assign(new Error(message), { name: 'BoxError', code });
const PLAIN = /^[A-Za-z0-9._-]+$/;

export function hostTap(options: {
  /** The supervisor's host line writer. */ line(kind: HostBoxKind, data: Record<string, unknown>): void;
  /** The run's unique label value, put on every host box as on every box the run makes. */ runLabelKey?: string; runLabel?: string;
  /** The process now running (its gen): the gen of a box.exec or box.ended line. Absent: the box's maker's. */ gen?: () => number;
}): HostTap & {
  /** The supervisor READ host box `key`'s bound label: its held lines are written now, and its later ones at once. */ bound(key: string, label: string): void;
  /** The supervisor is about to take attempt `gen`'s box away (a kill of kind box): that box's end is a kill. */ killing(gen: number): void;
  /** End host box `id` THROUGH the tap (its box.ended is written): true when the tap holds it or could attach it as a keyed host box, false when it is not a host box of this run's (the caller ends it as a tool box). */
  end(id: string, context: Parameters<BoxProvider['attach']>[1]): Promise<{ ok: boolean; host: boolean }>;
} {
  /** The start whose unheld window ran and whose box is not made yet. */
  let pending: { provider: string; key: string; gen: number; tried?: string } | undefined;
  const byKey = new Map<string, HostBox>();
  const byId = new Map<string, HostBox>();
  const killing = new Set<number>();
  /** A box's key, learned from the labels a tapped list() or create saw: the id -> key a later attach matches. */
  const keyById = new Map<string, string>();
  /** The tapped providers, by name: the way to attach a keyed host box this life has not held yet, to end it through the tap. */
  const tappedByName = new Map<string, BoxProvider>();
  const rawByName = new Map<string, BoxProvider>();
  const now = () => new Date().toISOString();
  const current = (box: HostBox) => options.gen?.() ?? box.gen;
  const write = (box: HostBox, kind: HostBoxKind, data: Record<string, unknown>, gen: number = box.gen) => {
    if (box.label === undefined) { box.held.push({ kind, data, gen }); return; }
    try { options.line(kind, { gen, box: box.label, ...data }); } catch { /* a recording line never fails a call */ }
  };
  const track = (id: string, start: { provider: string; key: string; gen: number }): HostBox => {
    const box: HostBox = { key: start.key, provider: start.provider, gen: start.gen, held: [], ended: false };
    byKey.set(start.key, box);
    byId.set(id, box);
    return box;
  };
  /** This run's key of a box: its key label, when it also carries this run's label (a box of another run's is none of this run's). */
  const keyIn = (labels: Readonly<Record<string, string>> | undefined): string | undefined => {
    const key = labels?.[HOST_KEY_LABEL];
    if (typeof key !== 'string' || key === '') return undefined;
    if (options.runLabelKey && options.runLabel && labels?.[options.runLabelKey] !== options.runLabel) return undefined;
    return key;
  };
  /** Box `id`'s key from one list() of this run's boxes: the fallback when no tapped list() or create showed it. */
  const keyOfListed = async (provider: BoxProvider, id: string, context: Parameters<BoxProvider['attach']>[1]): Promise<string | undefined> => {
    const listed = await provider.list(options.runLabelKey && options.runLabel ? { [options.runLabelKey]: options.runLabel } : {}, context);
    if (!listed.ok) return undefined;
    const key = keyIn(listed.value.find((ref) => ref.id === id)?.labels);
    if (key !== undefined) keyById.set(id, key);
    return key;
  };
  const created = (box: HostBox, made: Box, from: string) => {
    const facts = made.facts();
    write(box, 'box.created', { provider: box.provider, facts: { isolation: facts.isolation, cpus: facts.cpus, gpu: facts.gpu }, role: 'host', from });
  };
  const end = (box: HostBox) => {
    if (box.ended) return;
    box.ended = true;
    const gen = current(box);
    write(box, 'box.ended', { provider: box.provider, killed: killing.has(gen) || killing.has(box.gen) }, gen);
  };
  const wrap = (made: Box, box: HostBox): Box => { const handle = new Proxy(made, { get(target, name) {
    const member = Reflect.get(target, name, target);
    if (name === 'exec') {
      return async (...args: unknown[]) => {
        const at = now();
        // The process the command ran in, and whether it BEGAN before the bind, are decided now: one whose answer comes after the bind keeps its own time too.
        const gen = current(box);
        const held = box.label === undefined;
        const started = await (member as Box['exec']).apply(target, args as Parameters<Box['exec']>);
        // A command begun before the bind keeps its own time (`at`); one begun after it is written at once, with none.
        if (started.ok) write(box, 'box.exec', held ? { at } : {}, gen);
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
  } }); box.handle = handle; return handle; };

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
        // A host driver that adopts lists first: the keys its answer carries are what a later attach is matched by.
        list: async (labels, context) => {
          const listed = await provider.list(labels, context);
          if (listed.ok) for (const ref of listed.value) { const key = keyIn(ref.labels); if (key !== undefined) keyById.set(ref.id, key); }
          return listed;
        },
        create: async (spec, context) => {
          const start = pending;
          // FAIL CLOSED: a host box no unheld window announced could never be labelled; it is refused before any box is made.
          if (start === undefined || start.provider !== provider.name) return { ok: false, error: boxError('invalid', `a host box made outside the place's unheld window has no label: refused before any box is made`) } as never;
          const from = now();
          // The box's key is the one its host driver minted for this create (its key label), else, from a driver that mints none, the start's.
          const key = keyIn(labelled(spec).labels) ?? start.key;
          const made = await provider.create(labelled(spec), context);
          // A create that failed keeps the start pending: a box it made anyway is found by the place's list and attached.
          if (!made.ok) { pending = { ...start, tried: key }; return made; }
          pending = undefined;
          keyById.set(made.value.id, key);
          const box = track(made.value.id, { ...start, key });
          created(box, made.value, from);
          return { ok: true, value: wrap(made.value, box) } as typeof made;
        },
        attach: async (id, context) => {
          const found = await provider.attach(id, context);
          if (!found.ok || !found.value) return found;
          let box = byId.get(id);
          if (box === undefined) {
            const start = pending;
            const key = keyById.get(id) ?? (await keyOfListed(provider, id, context));
            if (start !== undefined && start.provider === provider.name && (key === undefined || key === start.tried)) {
              // The box this start's failed create made anyway (its own key, or a driver that mints none): this start's, created now.
              pending = undefined;
              box = track(id, { ...start, key: key ?? start.key });
              created(box, found.value, now());
            } else if (key !== undefined) {
              // A keyed host box of this run's that this life did not make: ADOPTED. Its lines carry the adopting process's gen; the rule for its
              // box.created in a recording that does not name it yet is held (Amendment 2), so none is written here.
              box = track(id, { provider: provider.name, key, gen: options.gen?.() ?? 0 });
            } else {
              // A box without the key label is never taken as this run's host box: it passes through, unrecorded.
              return found;
            }
          }
          return { ok: true, value: box.handle ?? wrap(found.value, box) } as typeof found;
        },
      };
      tappedByName.set(provider.name, tapped);
      rawByName.set(provider.name, provider);
      return tapped as unknown as P;
    },
    bound(key: string, label: string): void {
      const box = byKey.get(key);
      if (box === undefined || box.label !== undefined) return;
      box.label = label;
      for (const { kind, data, gen } of box.held.splice(0)) write(box, kind, data, gen);
    },
    killing(gen: number): void { killing.add(gen); },
    async end(id, context) {
      let handle = byId.get(id)?.handle;
      if (handle === undefined) {
        // A KEYED host box this life has not held: attached through the tapped provider (adopted by its key), then ended through it.
        // A box with no key is never attached here: it is a tool box, the caller's to end.
        for (const [name, tapped] of tappedByName) {
          const raw = rawByName.get(name)!;
          if ((keyById.get(id) ?? (await keyOfListed(raw, id, context))) === undefined) continue;
          const found = await tapped.attach(id, context);
          if (found.ok && found.value && byId.has(id)) { handle = found.value; break; }
        }
      }
      if (handle === undefined) return { ok: true, host: false };
      const gone = await handle.destroy(context);
      return { ok: gone.ok, host: true };
    },
  };
}

