// The part of an Archil disk ArchilWorkspace calls (archil.ts): its file API and its serverless exec, behind one seam,
// so the workspace is tested against a fake (test/fixtures/archil-fake.mjs) and runs on Archil's Node SDK, the npm
// package `disk`, pinned at 1.12.0. What the SDK does, read from its shipped types and source:
// - Credentials: one account API key, sent as `Authorization: Bearer <key>` both to the control plane (disks.get, grep,
//   exec) and to the disk's S3-compatible endpoint (objects). The key is an option, a function asked on every call
//   (serve keeps keys in its sealed store); nothing here reads the environment, and every setting is passed to the SDK
//   so it reads none of its own either. The key is never logged, returned or put in an error.
// - Endpoints: the region names the control plane. The S3 endpoint is given here explicitly (the setting
//   AGENTRUN_ARCHIL_S3_URL): the SDK derives it from the region internally, and no exported part of it says which it
//   is. The same URL goes to the SDK's public `s3BaseUrl` option and to the ranged read below, so both talk to one
//   endpoint. Since the account key goes to it, it must be https on an Archil host for the disk's region (the live one:
//   s3.green.us-east-1.aws.prod.archil.com for aws-us-east-1); plain http only to this machine's loopback, in tests.
// - Objects: putObject is one PUT up to 16 MiB, above it a multipart upload that appears whole when it completes;
//   appendObject takes at most 1 MiB a call and the SDK never retries it (a retry could append twice); deleteObject is
//   idempotent; listObjects is ListObjectsV2, one level under a "/" delimiter unless recursive, in pages. The disk is a
//   filesystem, so "a/" is a directory: putting an empty "a/" makes one. There is no rename, copy or link call.
// - A ranged read is the S3 Range header, which the SDK has no option for: it is a plain GET of
//   <S3 endpoint>/<disk>/<key> with the same Bearer key and a Range header, tried again on a 429, a 5xx or a failed
//   connection, as the SDK does its own reads. A redirect is never followed (the key would go with it), and each try
//   gives up after readTimeoutMs. No more than the range is read: a 206 whose Content-Range is another slice is refused,
//   and a 200 that ignored the range is read only up to the range's end.
// - grep: ripgrep's regex, a directory, recursive or not, a deadline of at most 30 s, 1,000 results by default; when it
//   stops early its matches are a sample, not the first ones.
// - exec: Archil.exec({ disks, command, baseImage | imageId }) runs one shell line in a fresh container with each disk
//   mounted at /mnt/archil/<name>. A mount with `subdirectory` exposes that folder only, and with `queueMs` (and no
//   checkoutPaths) it holds that folder for the line, waiting up to queueMs for another client's hold. `disks` is a map
//   from mount name to a mount, so one disk can be mounted twice, each a different folder (the types allow it; the docs
//   neither promise nor forbid it). It answers once the line ended, with stdout and stderr as text (cut by Archil
//   somewhere below 14 MB, measured live) and the exit code. The SDK retries it only when the connection failed, so a
//   line never runs twice. With no image, Archil's default exec image (measured live: git 2.34.1).
import type { Archil as ArchilClient, Disk as SdkDisk } from "disk";

/** One object of a listing: its whole key, and its size in bytes. */
export type ArchilObject = { readonly key: string; readonly size: number };
/** One page of a listing: objects at that level, and the "<prefix>…/" directories below it (with a delimiter). */
export type ArchilListPage = { readonly objects: readonly ArchilObject[]; readonly commonPrefixes: readonly string[]; readonly next?: string };
export type ArchilGrepRequest = {
  readonly directory: string;
  readonly pattern: string;
  readonly recursive: boolean;
  readonly maxResults: number;
  readonly maxDurationSeconds: number;
  readonly globs?: readonly string[];
};
export type ArchilGrepAnswer = {
  readonly matches: readonly { readonly file: string; readonly line: number; readonly text: string }[];
  readonly stoppedReason: string;
};
/** The image an exec runs in, pinned by digest: a public OCI reference `<name>@sha256:<64 hex>`, or an image built
 *  through Archil's images API with the digest it was built at (checked against Archil before the first exec). */
export type ArchilImage = { readonly baseImage: string } | { readonly imageId: string; readonly digest: string };

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `image` checked as an ArchilImage pinned by digest, and copied: only its own fields, nothing else it carries. */
export function pinnedImage(image: unknown): ArchilImage {
  const refuse = (): never => { throw new Error("an Archil exec image is pinned by digest: { baseImage: \"<name>@sha256:<64 hex>\" } or { imageId: \"<64 hex>\", digest: \"sha256:<64 hex>\" }"); };
  if (typeof image !== "object" || image === null) return refuse();
  const { baseImage, imageId, digest } = image as Record<string, unknown>;
  if (baseImage !== undefined) {
    if (imageId !== undefined || digest !== undefined || typeof baseImage !== "string" || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(baseImage)) return refuse();
    return { baseImage };
  }
  if (typeof imageId !== "string" || !/^[0-9a-f]{64}$/.test(imageId) || typeof digest !== "string" || !DIGEST.test(digest)) return refuse();
  return { imageId, digest };
}

/** One exec: `command` runs with each folder of `mounts` (mount name → folder of the disk), and nothing else of the
 *  disk, at /mnt/archil/<name>, each held for the line (waiting up to queueMs for another client's hold), in `image` or
 *  Archil's default. */
export type ArchilExecRequest = {
  readonly mounts: Readonly<Record<string, string>>;
  readonly queueMs: number;
  readonly command: string;
  readonly image?: ArchilImage;
};
export type ArchilExecAnswer = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/**
 * An Archil disk, keys relative to its root. A failed call rejects with an error carrying the HTTP `status` when there
 * was an answer (the SDK's ArchilS3Error and ArchilApiError do, and so does the ranged read here).
 */
export interface ArchilDisk {
  readonly id: string;
  /** GET `key` with the Range header `range` ("bytes=a-b"): 206 with the slice (a Content-Range other than one starting
   *  at a is refused), 200 with the object from its start up to b at most if the range was ignored (the rest is not
   *  read), or 416 (an empty body) when it starts past the end. */
  getRange(key: string, range: string): Promise<{ readonly status: number; readonly body: Uint8Array }>;
  /** Resolves once the disk answered 200: the object is committed. */
  putObject(key: string, body: Uint8Array): Promise<void>;
  /** At most 1 MiB. Resolves once the disk answered 200. */
  appendObject(key: string, body: Uint8Array): Promise<void>;
  deleteObject(key: string): Promise<void>;
  /** The keys that were not deleted, with why. */
  deleteObjects(keys: readonly string[]): Promise<readonly { readonly key: string; readonly code?: string; readonly message?: string }[]>;
  listPage(prefix: string, options: { readonly recursive: boolean; readonly token?: string }): Promise<ArchilListPage>;
  grep(request: ArchilGrepRequest): Promise<ArchilGrepAnswer>;
  exec(request: ArchilExecRequest): Promise<ArchilExecAnswer>;
}

export type ArchilDiskOptions = {
  /** The disk's id, dsk-<16 hex digits>. */
  readonly disk: string;
  /** Its region, e.g. aws-us-east-1: it names the control plane. */
  readonly region: string;
  /** The account API key, asked for on every call (serve gives it from its sealed store; nothing here reads the
   *  environment). A new key is taken up by the next call. */
  readonly key: () => string | Promise<string>;
  /** The disk's S3-compatible endpoint (the setting AGENTRUN_ARCHIL_S3_URL): https, on an Archil host for `region`. */
  readonly s3BaseUrl: string;
  /** Another control plane than the region's: a test's loopback server, which also lets s3BaseUrl be a loopback one. */
  readonly baseUrl?: string;
  /** How long one try of a ranged read may take (default 60 s). */
  readonly readTimeoutMs?: number;
};

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/; // key-gate: loopback-rule names loopback hosts to allow plain http only to them, in tests

/** The S3 endpoint, checked: https on an Archil host whose name carries the region ("aws-us-east-1" → "…​.us-east-1.aws.
 *  …archil.com"), or, when the control plane is a loopback one too (a test), http(s) to this machine's loopback. */
function checkS3Url(s3BaseUrl: unknown, region: string, baseUrl: string | undefined): URL {
  const refuse = (why: string): never => { throw new Error(`the Archil S3 endpoint (AGENTRUN_ARCHIL_S3_URL) ${why}`); };
  if (typeof s3BaseUrl !== "string") return refuse("is not given");
  let url: URL;
  try {
    url = new URL(s3BaseUrl);
  } catch {
    return refuse("is not a URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") refuse("carries more than a scheme, a host and a path");
  if (baseUrl !== undefined && LOOPBACK.test(url.hostname)) {
    let control: URL | undefined;
    try { control = new URL(baseUrl); } catch { control = undefined; }
    if (control !== undefined && LOOPBACK.test(control.hostname) && (url.protocol === "http:" || url.protocol === "https:")) return url;
  }
  if (url.protocol !== "https:") refuse("must be https: the account key goes to it");
  const parts = /^([a-z]+)-(.+)$/.exec(region);
  if (parts === null) refuse(`cannot be checked against region ${JSON.stringify(region)}`);
  const [, provider, location] = parts!;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".archil.com") || !host.includes(`.${location}.${provider}.`)) refuse(`must be an Archil host for region ${region}, not ${host}`);
  return url;
}

/** A failed ranged read: the status, and the gateway's code. */
class RangeReadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, statusText: string, body: string) {
    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
    super(`S3 GetObject (ranged) failed: ${status}${code === undefined ? "" : ` ${code}`} ${statusText}`.trim());
    this.name = "RangeReadError";
    this.status = status;
    this.code = code;
  }
}

const RANGE_TRIES = 3;
const READ_TIMEOUT_MS = 60_000;
const transient = (status: number): boolean => status === 429 || status >= 500;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** At most `limit` bytes of `response`'s body; the rest is not read (the stream is cancelled). */
async function upTo(response: Response, limit: number): Promise<Uint8Array> {
  const out = new Uint8Array(limit);
  let filled = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) return out.subarray(0, 0);
  try {
    while (filled < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, limit - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, filled);
}

class SdkArchilDisk implements ArchilDisk {
  readonly id: string;
  readonly #options: ArchilDiskOptions;
  readonly #s3: string;
  #ready: Promise<{ readonly client: ArchilClient; readonly disk: SdkDisk }> | undefined;
  /** The key #ready was made with: a different one from `key()` makes a new client. */
  #readyKey: string | undefined;
  /** Built images already checked to be at their pinned digest ("<imageId> <digest>"). */
  readonly #checkedImages = new Set<string>();

  constructor(options: ArchilDiskOptions) {
    const url = checkS3Url(options.s3BaseUrl, options.region, options.baseUrl);
    if (typeof options.key !== "function") throw new Error("the Archil API key is given as a function that returns it");
    this.#options = options;
    this.#s3 = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    this.id = options.disk;
  }

  /** The key, asked for now. */
  async #key(): Promise<string> {
    const apiKey = await this.#options.key();
    if (typeof apiKey !== "string" || apiKey === "") throw new Error("no Archil API key was given");
    return apiKey;
  }

  /** The client and the disk for the key asked for now: made again only when the key changed (one disks.get). Every
   *  setting is passed to the SDK, so it reads none of its own from the environment. */
  async #sdk(): Promise<{ readonly client: ArchilClient; readonly disk: SdkDisk }> {
    const apiKey = await this.#key();
    if (this.#ready !== undefined && this.#readyKey === apiKey) return this.#ready;
    const ready = (async () => {
      const { region, baseUrl } = this.#options;
      const { Archil } = await import("disk");
      const client = new Archil({ apiKey, region, s3BaseUrl: this.#s3, ...(baseUrl === undefined ? {} : { baseUrl }) });
      return { client, disk: await client.disks.get(this.id) };
    })();
    // A failed start (the key refused, the disk not found) is tried again by the next call.
    ready.catch(() => { if (this.#ready === ready) { this.#ready = undefined; this.#readyKey = undefined; } });
    this.#ready = ready;
    this.#readyKey = apiKey;
    return ready;
  }

  /** The client made and the disk looked up: one disks.get. A key of the wrong kind fails here (401 or 403). */
  async ready(): Promise<void> {
    await this.#sdk();
  }

  async getRange(key: string, range: string): Promise<{ readonly status: number; readonly body: Uint8Array }> {
    const url = `${this.#s3}/${encodeURIComponent(this.id)}/${key.replace(/^\//, "").split("/").map(encodeURIComponent).join("/")}`;
    const asked = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (asked === null) throw new Error(`a ranged read asks for "bytes=<first>-<last>", not ${JSON.stringify(range)}`);
    const start = Number(asked[1]);
    const end = Number(asked[2]);
    const headers = { Authorization: `Bearer ${await this.#key()}`, Range: range };
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        // No redirect is followed: the key would go with it.
        response = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(this.#options.readTimeoutMs ?? READ_TIMEOUT_MS) });
      } catch (error) {
        const why = String((error as { cause?: { message?: unknown } })?.cause?.message ?? (error as Error)?.message ?? error);
        if (/redirect/i.test(why)) throw new Error(`the Archil S3 endpoint answered a ranged read with a redirect, which is not followed: ${why}`);
        if (attempt >= RANGE_TRIES) throw error;
        await pause(100 * 2 ** attempt);
        continue;
      }
      if (response.status === 206) {
        // The slice asked for, or a refusal: other bytes are never taken for it.
        const sent = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
        if (sent === null || Number(sent[1]) !== start || Number(sent[2]) > end) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`the Archil S3 endpoint answered ${range} of ${key} with Content-Range ${JSON.stringify(response.headers.get("content-range"))}, not that slice`);
        }
        return { status: 206, body: await upTo(response, end - start + 1) };
      }
      // A 200 ignored the range: the object from its start, read no further than the range's end.
      if (response.ok) return { status: response.status, body: await upTo(response, end + 1) };
      const body = await response.text().catch(() => "");
      if (response.status === 416) return { status: 416, body: new Uint8Array(0) };
      if (transient(response.status) && attempt < RANGE_TRIES) {
        await pause(100 * 2 ** attempt);
        continue;
      }
      throw new RangeReadError(response.status, response.statusText, body);
    }
  }

  async putObject(key: string, body: Uint8Array): Promise<void> {
    await (await this.#sdk()).disk.putObject(key, body);
  }

  async appendObject(key: string, body: Uint8Array): Promise<void> {
    await (await this.#sdk()).disk.appendObject(key, body);
  }

  async deleteObject(key: string): Promise<void> {
    await (await this.#sdk()).disk.deleteObject(key);
  }

  async deleteObjects(keys: readonly string[]): Promise<readonly { readonly key: string; readonly code?: string; readonly message?: string }[]> {
    return (await (await this.#sdk()).disk.deleteObjects([...keys], { quiet: true })).errors;
  }

  async listPage(prefix: string, options: { readonly recursive: boolean; readonly token?: string }): Promise<ArchilListPage> {
    const page = await (await this.#sdk()).disk.listObjects(prefix, {
      recursive: options.recursive, singlePage: true, ...(options.token === undefined ? {} : { continuationToken: options.token }),
    });
    const next = page.isTruncated ? page.nextContinuationToken : undefined;
    return { objects: page.objects.map(({ key, size }) => ({ key, size })), commonPrefixes: page.commonPrefixes, ...(next === undefined ? {} : { next }) };
  }

  async grep(request: ArchilGrepRequest): Promise<ArchilGrepAnswer> {
    const answer = await (await this.#sdk()).disk.grep({ ...request, globs: request.globs === undefined ? undefined : [...request.globs] });
    return { matches: answer.matches.map(({ file, line, text }) => ({ file, line, text })), stoppedReason: answer.stoppedReason };
  }

  async exec(request: ArchilExecRequest): Promise<ArchilExecAnswer> {
    const { client } = await this.#sdk();
    // The image's own fields, picked by name; the command and the folder mount are set last, so nothing an image
    // object carries can replace them.
    const image = request.image === undefined ? undefined : pinnedImage(request.image);
    if (image !== undefined && "imageId" in image) {
      const pin = `${image.imageId} ${image.digest}`;
      if (!this.#checkedImages.has(pin)) {
        const built = await client.images.get(image.imageId);
        if (built.status !== "ready" || built.digest !== image.digest) {
          throw new Error(`the Archil exec image ${image.imageId} is ${built.status} at digest ${built.digest ?? "(none)"}, not at its pinned digest ${image.digest}: nothing was run`);
        }
        this.#checkedImages.add(pin);
      }
    }
    const answer = await client.exec({
      ...(image === undefined ? {} : "baseImage" in image ? { baseImage: image.baseImage } : { imageId: image.imageId }),
      command: request.command,
      disks: Object.fromEntries(Object.entries(request.mounts).map(([name, subdirectory]) => [name, { disk: this.id, subdirectory, queueMs: request.queueMs }])),
    });
    return { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr };
  }
}

/** Disk `options.disk` through Archil's SDK, its key asked of `options.key` on every call. */
export const archilDisk = (options: ArchilDiskOptions): ArchilDisk & { ready(): Promise<void> } => new SdkArchilDisk(options);
