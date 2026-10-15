// Every look the guard answers, kept in the run's store: one `vision.looks` document per look key, its entries in filing order, each the
// whole LookRecord (`facts.key`, `kept`, `cost_usd`, `status`, `model`), the screenshot's evidence path as its receipt, and the image the eyes
// were shown as a blob. The counters fold from it (looks paid, kept after a kill, the eyes' cost, under draft 21 of the recording format), so a
// screenshot the guard sends to the eyes is counted in the strip and the manifest's cost, the vision panel shows the chart, and a citation can
// be tied to its look. The package reports each look through `onLook`; nothing else keeps it.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { defineDocFamily, type ConversationId, type Extension, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import type { LookRecord } from '@parcha/pi-vision';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';

/** An image the eyes were shown: its mime type and the SHA-256 of its bytes (a blob of a recording, when there is one). */
export type ShownImage = { type: 'image'; mimeType: string; blob: string };
/** One look as filed. `receipt` is the screenshot's evidence path (the receipt the lead cites). `incarnation` is an id drawn at each process start,
 *  so a fold tells a key paid by two processes from one paid twice by one. */
export type FiledLook = { receipt: string | null; record: LookRecord; images: ShownImage[]; incarnation: string };

const INCARNATION = randomUUID();

export const VisionLooks = defineDocFamily<{ looks: FiledLook[] } & JsonObject, null>({
  kind: 'vision.looks', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ looks: [] }),
});

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** The screenshot each conversation last took, from a hook installed before vision's guard: the guard then hands the image to the eyes and the
 *  lead never holds it. `keep` stores an image's bytes (a recording's blob) and returns its SHA-256. It changes no result. */
export function shownShots(options: { keep?: (bytes: Buffer, extension: string) => string } = {}) {
  const byConversation = new Map<string, { receipt: string | null; images: ShownImage[] }>();
  const extension = {
    name: 'hero-shots', tools: [], wraps: [],
    hooks: [{ task: 'pi.tool', handlers: { afterTool: async (call: { name: string }, result: Record<string, unknown>, api: { conversationId: unknown }) => {
      if (call.name !== 'screenshot') return undefined;
      const blocks = (['output', 'content'].map((name) => result[name]).find(Array.isArray) ?? []) as { type: string; data?: string; mimeType?: string }[];
      const images: ShownImage[] = blocks.flatMap((block) => {
        if (block.type !== 'image' || typeof block.data !== 'string') return [];
        const bytes = Buffer.from(block.data, 'base64');
        const mimeType = block.mimeType ?? 'image/jpeg';
        return [{ type: 'image' as const, mimeType, blob: options.keep ? options.keep(bytes, EXTENSIONS[mimeType] ?? 'bin') : createHash('sha256').update(bytes).digest('hex') }];
      });
      const evidence = (result.details as { evidence?: unknown } | undefined)?.evidence;
      byConversation.set(String(api.conversationId), { receipt: typeof evidence === 'string' ? evidence : null, images });
      return undefined;
    } } }],
  } as unknown as Extension;
  return { extension, of: (conversationId: string) => byConversation.get(conversationId) };
}

/** The vision options that keep each reported look in `VisionLooks`, in its own commit, once the look is reported, with the screenshot it was of.
 *  `harness` is the run's, undefined until it is open. `cites` (a file) gets one line per look kept: what a result cites a screenshot by. */
export function keepLooks(harness: () => Harness | undefined, options: { shown?: ReturnType<typeof shownShots>; cites?: string } = {}): Pick<VisionAdapterOptions, 'onLook'> {
  return {
    onLook: async (look) => {
      const open = harness();
      if (!open || !look.record) return;
      const shot = options.shown?.of(look.conversationId);
      // A record's optional facts may be undefined, which a document does not hold: it is kept as its JSON.
      const value = JSON.parse(JSON.stringify({ receipt: shot?.receipt ?? look.receipt, record: look.record, images: shot?.images ?? [], incarnation: INCARNATION } satisfies FiledLook));
      await open.commit(async (tx) => { (await tx.doc(VisionLooks, Number(look.conversationId) as unknown as ConversationId, look.record.facts.key, null)).looks.push(value); }, ctx);
      if (options.cites && value.receipt) appendFileSync(options.cites, `${JSON.stringify({ receipt: value.receipt, look: look.record.facts.key, blob: value.images[0]?.blob ?? null })}\n`);
    },
  };
}
