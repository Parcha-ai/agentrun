// The audit's badge reads. A README badge is an SVG that carries its words as text (`<title>`, `<text>`, `aria-label`),
// and a `.svg` path reaches the model as that text. So `badge_image` turns the badge into a PNG in the node's workspace
// and returns only its path and size, and vision's `read` asks the eyes what the pixels say: a badge a finding cites
// comes from a vision receipt, never from the SVG's text.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { TSchema } from '@earendil-works/pi-ai';
import { defineDocFamily, type ConversationId, type Extension, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import type { LookRecord } from '@parcha/pi-vision';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';
import sharp from 'sharp';

/** What the repository node asks of each badge image. */
export const BADGE_ASK = 'What does this badge say? Its label and its value, exactly as shown.';

/** A badge is about 100x20 px; four times that is what the eyes read. */
const SCALE = 4;
const MAX_BYTES = 256 * 1024;
const MAX_PIXELS = 4_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const DRAW_SECONDS = 10;
const FORMATS = new Set(['svg', 'png', 'gif', 'jpeg', 'webp']);

/** The badge's bytes, fetched from a public URL. */
export type BadgeFetch = (url: URL, signal: AbortSignal) => Promise<Uint8Array>;

/** What `badge_image` saved: the path the model reads, its pixels and their SHA-256 (the `facts.sha256` of the look at it). */
export type BadgeImage = { path: string; width: number; height: number; sha256: string; png: Uint8Array };

/** Loopback, private, shared, link-local, documentation, benchmark, multicast and reserved ranges. An IPv4 address
 *  inside IPv6 is checked against the IPv4 ranges. */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) NOT_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 127], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

const isPublic = (address: string) => { const family = isIP(address); return family !== 0 && !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4'); };
const refused = (why: string) => Object.assign(new Error(`not a public badge URL: ${why}`), { code: 'BADGE_URL_REFUSED' });

/** An https URL on the default port, with no credentials, whose host is not an address outside the public internet. */
function checked(url: URL): URL {
  if (url.protocol !== 'https:') throw refused('only https is fetched');
  if (url.username || url.password) throw refused('it carries credentials');
  if (url.port) throw refused('only the default port is fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublic(host)) throw refused('its address is not public');
  return url;
}

/** Every address a name resolves to must be public, and the connection goes to one of those: a name cannot resolve
 *  to a public address for the check and a private one for the connection. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, ...(options.family ? { family: options.family } : {}) }).then((addresses) => {
    if (!addresses.length || !addresses.every((entry) => isPublic(entry.address))) throw refused(`${hostname} resolves to an address that is not public`);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }).catch((error: NodeJS.ErrnoException) => callback(error, '', 0));
};

/** GETs a badge from the public internet: https only, at most `MAX_BYTES`, redirects followed and checked again. */
export const publicFetch: BadgeFetch = async (url, signal) => {
  let at = checked(url);
  for (let hop = 0; ; hop += 1) {
    const answer = await new Promise<{ status: number; location?: string; body?: Uint8Array }>((resolve, reject) => {
      const sent = request(at, { method: 'GET', lookup: publicLookup, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), headers: { accept: 'image/svg+xml,image/*' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { response.resume(); return resolve({ status, ...(response.headers.location ? { location: response.headers.location } : {}) }); }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) response.destroy(new Error(`the badge is over ${MAX_BYTES} bytes`));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      sent.on('error', reject);
      sent.end();
    });
    if (answer.location === undefined) {
      if (answer.status !== 200 || !answer.body) throw new Error(`the badge URL answered ${answer.status}`);
      return answer.body;
    }
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    at = checked(new URL(answer.location, at));
  }
};

/** The badge as a PNG at `SCALE` times its size: an SVG is drawn at that density, any other image scaled by whole pixels. */
async function rasterize(bytes: Uint8Array): Promise<{ png: Buffer; width: number; height: number }> {
  const format = (await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata()).format;
  if (!FORMATS.has(format)) throw new Error('the URL did not answer with an image');
  const vector = format === 'svg';
  let image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', ...(vector ? { density: 72 * SCALE } : {}) }).timeout({ seconds: DRAW_SECONDS });
  if (!vector) {
    const { width, height } = await image.metadata();
    image = image.resize(width * SCALE, height * SCALE, { kernel: 'nearest' });
  }
  const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** A name part of the saved file: lower case letters, digits, dots and dashes. The eyes are told the file's path, so it
 *  is made of the package's name and a fixed label, never of words the model read about the badge. */
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'badge';

const parameters = {
  type: 'object', additionalProperties: false, required: ['url', 'dependency', 'label'],
  properties: {
    url: { type: 'string', description: 'The badge image\'s https URL, as the README links it.' },
    dependency: { type: 'string', description: 'The dependency\'s package name.' },
    label: { type: 'string', enum: ['build', 'coverage', 'version', 'other'], description: 'What the badge measures.' },
  },
} as const;

/** The `badge_image` tool. `fetch` defaults to `publicFetch`; `onImage` sees each PNG saved, for a recorder's blob. The
 *  SVG's text is never in the result, the details or an error the model reads. */
export function badgeImageTool(options: { fetch?: BadgeFetch; onImage?: (image: BadgeImage) => void } = {}): Extension {
  const fetchBadge = options.fetch ?? publicFetch;
  const fail = (text: string) => ({ output: [{ type: 'text' as const, text }], content: [{ type: 'text' as const, text }], isError: true });
  return {
    name: 'badges',
    tools: [{
      name: 'badge_image',
      description: 'Save a README badge as a PNG image in the workspace and return its path and pixel size. Read the path with the read tool, with an ask, to learn what the badge says.',
      parameters: parameters as unknown as TSchema,
      // A GET of a public badge changes nothing: a call a kill cut fetches and writes the same file again.
      replay: 'safe',
      async execute(args, api, context) {
        const { url, dependency, label } = args as { url: string; dependency: string; label: string };
        if (!api.env) return fail('This conversation has no workspace to save the badge in.');
        let target: URL;
        try { target = checked(new URL(url)); } catch (error) { return fail(error instanceof TypeError ? 'That is not a URL.' : (error as Error).message); }
        let image: { png: Buffer; width: number; height: number };
        try { image = await rasterize(await fetchBadge(target, context.abortSignal ?? new AbortController().signal)); } catch (error) {
          context.abortSignal?.throwIfAborted();
          const why = (error as { code?: string }).code === 'BADGE_URL_REFUSED' ? (error as Error).message : 'it could not be fetched or drawn as an image';
          return fail(`The badge was not saved: ${why}.`);
        }
        const path = `badges/${slug(dependency)}-${slug(label)}.png`;
        const made = await api.env.createDir('badges', { recursive: true }, context);
        const wrote = made.ok ? await api.env.writeFile(path, image.png, context) : made;
        if (!wrote.ok) return fail('The badge could not be written to the workspace.');
        const saved = { path, width: image.width, height: image.height };
        try { options.onImage?.({ ...saved, sha256: createHash('sha256').update(image.png).digest('hex'), png: image.png }); } catch { /* the host's own */ }
        const text = JSON.stringify(saved);
        return { output: [{ type: 'text', text }], content: [{ type: 'text', text }], details: saved };
      },
    }],
  };
}

/** One look as filed: the receipt path the sink returned (null when it filed none) and the record. */
export type FiledLook = { receipt: string | null; record: LookRecord };

/** Every look a conversation filed, by its `facts.key` (the source's bytes, the question, the eyes and the plan), in
 *  filing order. The eyes answering one key again is a second entry, so a fold of this document alone counts looks
 *  paid, repeated and their cost; the look memos pi drops at the task's end are not needed. */
export const VisionLooks = defineDocFamily<{ looks: FiledLook[] } & JsonObject, null>({
  kind: 'vision.looks', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ looks: [] }),
});

/** The repository node's vision options, for `run`'s `vision` (merged over the assembly's own, whose `onLook` and
 *  `onMiss` run first and write the live lines). The eyes read every image, so the lead is never shown one and each
 *  receipt holds the eyes' words; `eyes` or `eyesModel` name them. Every look the host's sink files is also kept in
 *  `VisionLooks`. The sink is not told the conversation, so a filed record waits under its receipt path for the
 *  `onLook` or `onMiss` that follows it, which are. `harness` is read at each look: the run opens after this is built. */
export function visionOptions(host: { evidence: VisionAdapterOptions['evidence'] }, options: { harness: () => Harness | undefined } & Pick<VisionAdapterOptions, 'eyes' | 'eyesModel'>): Partial<VisionAdapterOptions> {
  const filed = new Map<string, LookRecord>();
  const keep = async (conversationId: string, receipt: string | null, record: LookRecord | undefined) => {
    const open = options.harness();
    if (!record || !open) return;
    // A record's optional facts may be undefined, which a document does not hold: it is kept as its JSON.
    const entry = JSON.parse(JSON.stringify({ receipt, record }));
    await open.commit(async (tx) => { (await tx.doc(VisionLooks, Number(conversationId) as unknown as ConversationId, record.facts.key, null)).looks.push(entry); }, ctx);
  };
  return {
    ...(options.eyes ? { eyes: options.eyes } : {}),
    ...(options.eyesModel ? { eyesModel: options.eyesModel } : {}),
    limits: () => ({ image: { native: false } }),
    evidence: {
      async file(label, record) {
        const at = await host.evidence.file(label, record);
        if (at) filed.set(at.path, record);
        return at;
      },
    },
    onLook: (look) => keep(look.conversationId, look.receipt, look.record),
    onMiss: (miss) => keep(miss.conversationId, miss.receipt, miss.receipt === null ? undefined : filed.get(miss.receipt)),
  };
}
