// Every look the guard answers, kept in the run's store: one `vision.looks` document per look key, its entries in filing order, each the
// whole LookRecord (`facts.key`, `kept`, `cost_usd`, `status`, `model`). The counters fold from it (looks paid, kept after a kill, the
// eyes' cost, under draft 21 of the recording format), so a screenshot the guard sends to the eyes is counted in the strip and the
// manifest's cost. The package reports each look through `onLook`; nothing else keeps it.
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { defineDocFamily, type ConversationId, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import type { LookRecord } from '@parcha/pi-vision';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';

/** One look as filed. `incarnation` is an id drawn at each process start, so a fold tells a key paid by two processes from one paid twice by one. */
export type FiledLook = { receipt: string | null; record: LookRecord; incarnation: string };

const INCARNATION = randomUUID();

export const VisionLooks = defineDocFamily<{ looks: FiledLook[] } & JsonObject, null>({
  kind: 'vision.looks', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ looks: [] }),
});

/** The vision options that keep each reported look in `VisionLooks`, in its own commit, once the look is reported. `harness` is the run's,
 *  undefined until it is open. */
export function keepLooks(harness: () => Harness | undefined): Pick<VisionAdapterOptions, 'onLook'> {
  return {
    onLook: async (look) => {
      const open = harness();
      if (!open || !look.record) return;
      // A record's optional facts may be undefined, which a document does not hold: it is kept as its JSON.
      const value = JSON.parse(JSON.stringify({ receipt: look.receipt, record: look.record, incarnation: INCARNATION } satisfies FiledLook));
      await open.commit(async (tx) => { (await tx.doc(VisionLooks, Number(look.conversationId) as unknown as ConversationId, look.record.facts.key, null)).looks.push(value); }, ctx);
    },
  };
}
