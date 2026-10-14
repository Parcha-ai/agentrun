// Every look the run's sink files, kept in the run's store: one `vision.looks` document per look key (the source's bytes, the
// question, the eyes and the plan), its entries in filing order. An entry is the receipt path, the whole LookRecord, the data set's
// item, the images the eyes were shown, the miss when the look failed, and the process that filed it. The counters fold from it
// alone (looks paid, kept after a kill, repeated, cost), so nothing depends on the look memos pi drops when a task ends.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { defineDocFamily, type ConversationId, type Extension, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import type { LookRecord, MissEvent } from '@parcha/pi-vision';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';

/** An image the eyes were shown: its SHA-256 (a blob of a recording, when there is one), and the film's second it was cut at. */
export type ShownImage = { type: 'image'; mimeType: string; blob: string; at?: number };

/** One look as filed. `incarnation` is an id drawn at each process start, so a fold tells a key paid by two processes from one paid
 *  twice by one. */
export type FiledLook = { receipt: string | null; record: LookRecord; item: string | null; images: ShownImage[]; miss: { code: string; reason: string } | null; incarnation: string };

const INCARNATION = randomUUID();

export const VisionLooks = defineDocFamily<{ looks: FiledLook[] } & JsonObject, null>({
  kind: 'vision.looks', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ looks: [] }),
});

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** The caption the package puts before a video frame: `Frame at <s> s.` */
const FRAME = /^Frame at (\d+(?:\.\d+)?) s\.$/;

/** The images each `read` showed the eyes, by conversation, from a hook installed before vision's guard: the guard then hands them
 *  to the eyes, and the lead's conversation never holds them. `keep` stores an image's bytes (a recording's blob) and returns its
 *  SHA-256; `onShown` sees each read's images and captions. It changes no result. */
export function shownImages(options: { keep?: (bytes: Buffer, extension: string) => string; onShown?: (shown: { conversationId: string; callId: string; args: Record<string, unknown>; media: unknown; content: unknown[] }) => void } = {}) {
  const byConversation = new Map<string, ShownImage[]>();
  const extension = {
    name: 'apollo11-shown', tools: [], wraps: [],
    hooks: [{ task: 'pi.tool', handlers: { afterTool: async (call: { id: string; name: string; arguments?: Record<string, unknown> }, result: Record<string, unknown>, api: { conversationId: unknown }) => {
      if (call.name !== 'read') return undefined;
      const blocks = (['output', 'content'].map((name) => result[name]).find(Array.isArray) ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
      if (!blocks.some((block) => block.type === 'image')) return undefined;
      const images: ShownImage[] = blocks.flatMap((block, at) => {
        if (block.type !== 'image' || typeof block.data !== 'string') return [];
        const bytes = Buffer.from(block.data, 'base64');
        const mimeType = block.mimeType ?? 'image/png';
        const blob = options.keep ? options.keep(bytes, EXTENSIONS[mimeType] ?? 'bin') : createHash('sha256').update(bytes).digest('hex');
        const second = FRAME.exec(blocks[at - 1]?.type === 'text' ? blocks[at - 1]!.text ?? '' : '')?.[1];
        return [{ type: 'image' as const, mimeType, blob, ...(second ? { at: Number(second) } : {}) }];
      });
      const conversationId = String(api.conversationId);
      byConversation.set(conversationId, images);
      const { ask: _ask, ...args } = call.arguments ?? {};
      // A caption is the short line before an image; the page's text layer is left out.
      const content = blocks.filter((block, at) => block.type === 'image' || (block.type === 'text' && blocks[at + 1]?.type === 'image' && (block.text?.length ?? 0) < 200));
      try { options.onShown?.({ conversationId, callId: call.id, args, media: (result.details as { media?: unknown } | undefined)?.media ?? null, content }); } catch { /* a recording line never fails a call */ }
      return undefined;
    } } }],
  } as unknown as Extension;
  return { extension, of: (conversationId: string) => byConversation.get(conversationId) ?? [] };
}

/** A kill inside the evidence sink: the Nth filing of the run, and those that reach the sink after it while it waits (up to `hold`,
 *  or `waitMs`), are never written. By then each one's answer is the call's memo and neither the look nor the read's result is
 *  committed, so the next process reads each answer back: kept, not paid again. `request` asks the supervisor to kill this process;
 *  `done` (a file) says the kill already happened, so the next process files normally. */
export type SinkKill = { n: number; hold: number; waitMs: number; done: string; request: (filing: { n: number; parked: number }) => void };

/** The run's vision options: the lead is never shown an image (`native: false`), so the eyes answer every one; `eyes` or `eyesModel`
 *  name them. Each filed record is kept in `VisionLooks` once the look is reported, in its own commit, with its item (`itemOf` the
 *  record's path), the images `shown` holds for its conversation and the miss `onMiss` told; `committed` (a file) gets one line per
 *  look so kept. */
export function visionOptions(host: { evidence: VisionAdapterOptions['evidence'] }, options: {
  harness: () => Harness | undefined; committed?: string; itemOf?: (path: string) => string | null; shown?: { of(conversationId: string): ShownImage[] }; sinkKill?: SinkKill;
} & Pick<VisionAdapterOptions, 'eyes' | 'eyesModel'>): Partial<VisionAdapterOptions> {
  // The sink is not told the conversation, so a filed record waits under its receipt path for the `onLook` or `onMiss` that follows.
  const filed = new Map<string, LookRecord>();
  let filings = 0;
  let parked = 0;
  const keep = async (conversationId: string, receipt: string | null, record: LookRecord | undefined, miss: MissEvent | null) => {
    const open = options.harness();
    if (!record || !open) return;
    const entry: FiledLook = {
      receipt, record, item: options.itemOf?.(record.args.path) ?? null, images: options.shown?.of(conversationId) ?? [],
      miss: miss ? { code: miss.code, reason: miss.reason } : null, incarnation: INCARNATION,
    };
    // A record's optional facts may be undefined, which a document does not hold: it is kept as its JSON.
    const value = JSON.parse(JSON.stringify(entry));
    await open.commit(async (tx) => { (await tx.doc(VisionLooks, Number(conversationId) as unknown as ConversationId, record.facts.key, null)).looks.push(value); }, ctx);
    if (options.committed) appendFileSync(options.committed, `${JSON.stringify({ key: record.facts.key, conversationId, status: record.status, kept: record.facts.kept === true, cost_usd: record.facts.cost_usd ?? null, pid: process.pid })}\n`);
  };
  const sink = options.sinkKill;
  return {
    ...(options.eyes ? { eyes: options.eyes } : {}),
    ...(options.eyesModel ? { eyesModel: options.eyesModel } : {}),
    limits: () => ({ image: { native: false } }),
    evidence: {
      async file(label, record) {
        filings += 1;
        if (sink && !existsSync(sink.done) && filings >= sink.n) {
          parked += 1;
          if (parked === 1) setTimeout(() => sink.request({ n: sink.n, parked }), sink.waitMs).unref();
          if (parked >= sink.hold) sink.request({ n: sink.n, parked });
          return new Promise<never>(() => {});
        }
        const at = await host.evidence.file(label, record);
        if (at) filed.set(at.path, record);
        return at;
      },
    },
    onLook: (look) => keep(look.conversationId, look.receipt, look.record, null),
    onMiss: (miss) => keep(miss.conversationId, miss.receipt, miss.receipt === null ? undefined : filed.get(miss.receipt), miss),
  };
}

/** The child's request for a sink kill, written once where the supervisor looks for it. */
export const requestKill = (file: string) => (filing: { n: number; parked: number }) => { try { writeFileSync(file, JSON.stringify(filing), { flag: 'wx' }); } catch { /* asked already */ } };
