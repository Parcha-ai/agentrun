// The reference entry's vision option. Every look the guard answers, kept in the run's store: one `vision.looks` document per look key, its entries in filing order, each the
// whole LookRecord (`facts.key`, `kept`, `cost_usd`, `status`, `model`), the screenshot's evidence path as its receipt, and the image the eyes
// were shown as a blob. The counters fold from it (looks paid, kept after a kill, the eyes' cost, under draft 21 of the recording format), so a
// screenshot the guard sends to the eyes is counted in the strip and the manifest's cost, the vision panel shows the chart, and a citation can
// be tied to its look. The package reports each look through `onLook`; nothing else keeps it.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { defineDocFamily, type ConversationId, type Extension, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import type { LookRecord, MissEvent } from '@parcha/pi-vision';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';

/** An image the eyes were shown: its mime type, the SHA-256 of its bytes (a blob of a recording, when there is one), and the film's second it was cut at, when it is a frame. */
export type ShownImage = { type: 'image'; mimeType: string; blob: string; at?: number };
/** One look as filed. `receipt` is the screenshot's evidence path (the receipt the lead cites). `incarnation` is an id drawn at each process start,
 *  so a fold tells a key paid by two processes from one paid twice by one. */
export type FiledLook = { receipt: string | null; record: LookRecord; item: string | null; images: ShownImage[]; miss: { code: string; reason: string } | null; incarnation: string };

const INCARNATION = randomUUID();

export const VisionLooks = defineDocFamily<{ looks: FiledLook[] } & JsonObject, null>({
  kind: 'vision.looks', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ looks: [] }),
});

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** The caption the package puts before a video frame: `Frame at <s> s.` */
const FRAME = /^Frame at (\d+(?:\.\d+)?) s\.$/;
/** One read's images as the guard is about to take them: what the entry writes as a live `vision`/`shown` line. */
export type Shown = { conversationId: string; callId: string; args: Record<string, unknown>; media: unknown; content: unknown[] };

/** The screenshot each conversation last took, from a hook installed before vision's guard: the guard then hands the image to the eyes and the
 *  lead never holds it. `keep` stores an image's bytes (a recording's blob) and returns its SHA-256. It changes no result. */
export function shownShots(options: { keep?: (bytes: Buffer, extension: string) => string; onShown?: (shown: Shown) => void } = {}) {
  // Each conversation's reads, newest last: a look finds the read it was of by its path (a screenshot by its receipt), never "the last one".
  const byConversation = new Map<string, { tool: string; receipt: string | null; images: ShownImage[]; path?: string }[]>();
  const extension = {
    name: 'entry-shown', tools: [], wraps: [],
    hooks: [{ task: 'pi.tool', handlers: { afterTool: async (call: { id: string; name: string; arguments?: Record<string, unknown> }, result: Record<string, unknown>, api: { conversationId: unknown }) => {
      // A browser screenshot and a read of an image file are the two ways an image reaches the guard; both are kept as what the eyes were shown.
      if (call.name !== 'screenshot' && call.name !== 'read') return undefined;
      const blocks = (['output', 'content'].map((name) => result[name]).find(Array.isArray) ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
      if (!blocks.some((block) => block.type === 'image')) return undefined;
      const images: ShownImage[] = blocks.flatMap((block, at) => {
        if (block.type !== 'image' || typeof block.data !== 'string') return [];
        const bytes = Buffer.from(block.data, 'base64');
        const mimeType = block.mimeType ?? 'image/jpeg';
        const second = FRAME.exec(blocks[at - 1]?.type === 'text' ? blocks[at - 1]!.text ?? '' : '')?.[1];
        return [{ type: 'image' as const, mimeType, ...(second ? { at: Number(second) } : {}), blob: options.keep ? options.keep(bytes, EXTENSIONS[mimeType] ?? 'bin') : createHash('sha256').update(bytes).digest('hex') }];
      });
      const evidence = (result.details as { evidence?: unknown } | undefined)?.evidence;
      const list = byConversation.get(String(api.conversationId)) ?? [];
      list.push({ tool: call.name, receipt: typeof evidence === 'string' ? evidence : null, images, ...(call.name === 'read' && typeof call.arguments?.path === 'string' ? { path: call.arguments.path } : {}) });
      byConversation.set(String(api.conversationId), list.slice(-50));
      // One live line per read: its arguments (the question left out), the media facts, and the captions with the images (the page's text layer is not kept).
      if (call.name === 'read' && options.onShown) {
        const { ask: _ask, ...args } = call.arguments ?? {};
        const content = blocks.filter((block, at) => block.type === 'image' || (block.type === 'text' && blocks[at + 1]?.type === 'image' && (block.text?.length ?? 0) < 200));
        try { options.onShown({ conversationId: String(api.conversationId), callId: call.id, args, media: (result.details as { media?: unknown } | undefined)?.media ?? null, content }); } catch { /* a recording line never fails a call */ }
      }
      return undefined;
    } } }],
  } as unknown as Extension;
  return {
    extension,
    /** The images the eyes were shown for this look: for a `read`, the newest read of the look's own file, and for a film window only the frames inside it; for another tool whose result held the image (a screenshot), that tool's newest. A look whose read produced no image finds none. */
    of: (conversationId: string, record: LookRecord | undefined, tool: string) => {
      const reads = [...(byConversation.get(conversationId) ?? [])].reverse();
      const entry = tool === 'read' ? reads.find((read) => read.tool === 'read' && record && read.path === record.args.path) : reads.find((read) => read.tool === tool);
      if (!entry) return undefined;
      const from = record?.args.from_s;
      const to = record?.args.to_s;
      return { receipt: entry.receipt, images: from !== undefined && to !== undefined ? entry.images.filter((image) => image.at === undefined || (image.at >= from && image.at <= to)) : entry.images };
    },
  };
}

/** The vision options that keep each reported look in `VisionLooks`, in its own commit, once the look is reported (a look that failed too: its miss `{ code, reason }`), with the screenshot or the
 *  images it was of and the data set's item it belongs to (`itemOf` the record's path). `filed` holds each filed record by its receipt path, so a miss, which names only the receipt, finds its
 *  record. `harness` is the run's, undefined until it is open. `cites` (a file) gets one line per look kept: what a result cites a screenshot by. */
export function keepLooks(harness: () => Harness | undefined, options: { shown?: ReturnType<typeof shownShots>; cites?: string; itemOf?: (path: string) => string | null; filed?: Map<string, LookRecord> } = {}): Pick<VisionAdapterOptions, 'onLook' | 'onMiss'> {
  const keep = async (conversationId: string, tool: string, receipt: string | null, record: LookRecord | undefined, miss: MissEvent | null) => {
    const open = harness();
    if (!open || !record) return;
    const shot = options.shown?.of(conversationId, record, tool);
    // A record's optional facts may be undefined, which a document does not hold: it is kept as its JSON.
    const value = JSON.parse(JSON.stringify({
      receipt: shot?.receipt ?? receipt, record, item: options.itemOf?.(String(record.args.path)) ?? null, images: shot?.images ?? [],
      miss: miss ? { code: miss.code, reason: miss.reason } : null, incarnation: INCARNATION,
    } satisfies FiledLook));
    await open.commit(async (tx) => { (await tx.doc(VisionLooks, Number(conversationId) as unknown as ConversationId, record.facts.key, null)).looks.push(value); }, ctx);
    if (options.cites && value.receipt) appendFileSync(options.cites, `${JSON.stringify({ receipt: value.receipt, look: record.facts.key, blob: value.images[0]?.blob ?? null })}\n`);
  };
  return {
    onLook: (look) => keep(look.conversationId, look.tool, look.receipt, look.record, null),
    onMiss: (miss) => keep(miss.conversationId, miss.tool, miss.receipt, miss.receipt === null ? undefined : options.filed?.get(miss.receipt), miss),
  };
}
