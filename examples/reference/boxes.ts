// The boxes capability: a pi-transport `BoxProvider` the entry hands a demo (to its tools as `context.boxes`, and to the job's own tools through `boxEnv`), with the crossings
// and the transport box lines of the run built in. A demo never writes either.
//
// The crossings (a demo's `kills[].point` names them; `n` picks the nth time):
//   transport.box.create    a box is about to be made
//   transport.box.created   a box exists and is not yet used
//   transport.box.exec      a box command is in flight: started, its answer not yet read. The crossing the audit demo's install kill names
//   transport.box.destroy   a box is about to be destroyed
// A crossing taken inside a tool call (between its dispatch and the host keeping its answer) is never a `target: "run"` kill point: a kill there leaves that call
// unknown. It can still be a `target: "tool"` kill: the box taken in the crossing is destroyed once, the run's process lives, and no kill line is written.
//
// The transport lines (live lines, source `transport`): `box.created` { box, provider }, `box.killed` { box, crossing } (a planned loss, written before the box is
// destroyed), `box.ended` { box, provider, killed } (the box is gone, however it ended).
import type { Box, BoxProvider } from '@parcha/pi-transport';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { Cross, EffectWindow } from './crossings.ts';
import type { Recorder } from './record.ts';

export const BOX_CROSSINGS = ['transport.box.create', 'transport.box.created', 'transport.box.exec', 'transport.box.destroy'] as const;

export function tapBox(provider: BoxProvider, options: { cross: Cross; window: EffectWindow; recorder?: Recorder }): BoxProvider {
  const { cross, recorder } = options;
  const line = (kind: 'box.created' | 'box.killed' | 'box.ended', data: Record<string, unknown>) => { try { recorder?.live('transport', kind, data); } catch { /* a recording line never fails a call */ } };
  // A crossing in a tool call cannot end the run's process: it is logged, and it may still end the box.
  const taken = (point: string) => cross(point, { cut: options.window.open === 0 });
  const wrap = (box: Box): Box => {
    let ended = false;
    let killed = false;
    const end = () => { if (!ended) { ended = true; line('box.ended', { box: box.id, provider: provider.name, killed }); } };
    const lose = async (point: string) => { killed = true; line('box.killed', { box: box.id, crossing: point }); await box.destroy(ctx); end(); };
    return new Proxy(box, { get(target, name) {
      const member = Reflect.get(target, name, target);
      if (name === 'exec') {
        return async (...args: unknown[]) => {
          const started = await (member as Box['exec']).apply(target, args as Parameters<Box['exec']>);
          if (started.ok && taken('transport.box.exec')) await lose('transport.box.exec');
          return started;
        };
      }
      if (name === 'destroy') {
        return async (...args: unknown[]) => {
          if (taken('transport.box.destroy')) killed = true;
          const result = await (member as Box['destroy']).apply(target, args as Parameters<Box['destroy']>);
          end();
          return result;
        };
      }
      return typeof member === 'function' ? member.bind(target) : member;
    } });
  };
  return {
    name: provider.name,
    attach: (id, context) => provider.attach(id, context),
    list: (labels, context) => provider.list(labels, context),
    create: async (spec, context) => {
      taken('transport.box.create');
      const made = await provider.create(spec, context);
      if (!made.ok) return made;
      line('box.created', { box: made.value.id, provider: provider.name });
      const box = wrap(made.value);
      if (taken('transport.box.created')) await (box.destroy as Box['destroy'])(context);
      return { ok: true, value: box } as typeof made;
    },
  };
}
