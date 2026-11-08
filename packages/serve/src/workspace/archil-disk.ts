// The part of an Archil disk ArchilWorkspace calls (archil.ts): its file API and its serverless exec, behind one seam,
// so the workspace is tested against a fake (test/fixtures/archil-fake.mjs) and runs on Archil's Node SDK, the npm
// package `disk`, pinned at 1.12.0. What the SDK does, read from its shipped types and source:
// - Credentials: one account API key, sent as `Authorization: Bearer <key>` both to the control plane (disks.get, grep,
//   exec) and to the disk's S3-compatible endpoint (objects). The region picks both hosts. The key is read here from
//   the environment by its variable's NAME, when the first call is made; it is never logged, returned or put in an
//   error.
// - Objects: putObject is one PUT up to 16 MiB, above it a multipart upload that appears whole when it completes;
//   appendObject takes at most 1 MiB a call and the SDK never retries it (a retry could append twice); deleteObject is
//   idempotent; listObjects is ListObjectsV2, one level under a "/" delimiter unless recursive, in pages. The disk is a
//   filesystem, so "a/" is a directory: putting an empty "a/" makes one. There is no rename, copy or link call.
// - A ranged read is the S3 Range header, which the SDK has no option for: it goes through the SDK's own S3 request (its
//   credential, endpoint, transport and retries) with that one header. That request is internal to the SDK; the pin
//   holds it, and a missing one fails in words.
// - grep: ripgrep's regex, a directory, recursive or not, a deadline of at most 30 s, 1,000 results by default; when it
//   stops early its matches are a sample, not the first ones.
// - exec: Archil.exec({ disks, command }) runs one shell line in a fresh container with each disk mounted at
//   /mnt/archil/<name>, after checking out `checkoutPaths` (waiting up to `queueMs` for another client's), and answers
//   once the line ended, with stdout and stderr as text and the exit code. The SDK retries it only when the connection
//   failed, so a line never runs twice.
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
/** One exec: `command` runs with the disk at /mnt/archil/<mount>, `checkoutPaths` checked out first. */
export type ArchilExecRequest = { readonly mount: string; readonly checkoutPaths: readonly string[]; readonly queueMs: number; readonly command: string };
export type ArchilExecAnswer = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/**
 * An Archil disk, keys relative to its root. A failed call rejects with an error carrying the HTTP `status` when there
 * was an answer (the SDK's ArchilS3Error and ArchilApiError do).
 */
export interface ArchilDisk {
  readonly id: string;
  /** GET `key` with the Range header `range` ("bytes=a-b"): 206 with the slice, 200 with the whole object if the
   *  range was ignored, or 416 (an empty body) when it starts past the end. */
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
  /** Its region, e.g. aws-us-east-1. */
  readonly region: string;
  /** The NAME of the environment variable that holds the account API key. */
  readonly keyEnv: string;
  /** Other endpoints than the region's (a test's loopback server). */
  readonly baseUrl?: string;
  readonly s3BaseUrl?: string;
};

/** The SDK's own S3 request (Disk#_s3Request in 1.12.0), which the ranged read needs for its one header. */
type S3Request = (method: "GET", key: string, options: { readonly extraHeaders: Record<string, string> }) =>
  Promise<{ readonly ok: boolean; readonly status: number; readonly statusText: string; readonly body: Uint8Array }>;

/** A failed ranged read: the status, and the gateway's words. */
class RangeReadError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, body: Uint8Array) {
    const code = /<Code>([^<]*)<\/Code>/.exec(Buffer.from(body).toString("utf8"))?.[1];
    super(`S3 GetObject (ranged) failed: ${status}${code === undefined ? "" : ` ${code}`} ${statusText}`.trim());
    this.name = "RangeReadError";
    this.status = status;
  }
}

class SdkArchilDisk implements ArchilDisk {
  readonly id: string;
  readonly #options: ArchilDiskOptions;
  #ready: Promise<{ readonly client: ArchilClient; readonly disk: SdkDisk }> | undefined;

  constructor(options: ArchilDiskOptions) {
    this.#options = options;
    this.id = options.disk;
  }

  /** The client and the disk, made once: the key read by name, the disk looked up once. */
  #sdk(): Promise<{ readonly client: ArchilClient; readonly disk: SdkDisk }> {
    if (this.#ready !== undefined) return this.#ready;
    const ready = (async () => {
      const { keyEnv, region, baseUrl, s3BaseUrl } = this.#options;
      const apiKey = process.env[keyEnv];
      if (apiKey === undefined || apiKey === "") throw new Error(`the Archil API key's variable ${keyEnv} is not set`);
      const { Archil } = await import("disk");
      const client = new Archil({ apiKey, region, ...(baseUrl === undefined ? {} : { baseUrl }), ...(s3BaseUrl === undefined ? {} : { s3BaseUrl }) });
      return { client, disk: await client.disks.get(this.id) };
    })();
    // A failed start (no key, the disk not found) is tried again by the next call.
    ready.catch(() => { if (this.#ready === ready) this.#ready = undefined; });
    this.#ready = ready;
    return ready;
  }

  async getRange(key: string, range: string): Promise<{ readonly status: number; readonly body: Uint8Array }> {
    const { disk } = await this.#sdk();
    const request = (disk as unknown as { _s3Request?: S3Request })._s3Request;
    if (typeof request !== "function") throw new Error("this version of the Archil SDK has no S3 request for a ranged read (pinned: disk 1.12.0)");
    const answer = await request.call(disk, "GET", key, { extraHeaders: { Range: range } });
    if (answer.ok || answer.status === 416) return { status: answer.status, body: answer.ok ? answer.body : new Uint8Array(0) };
    throw new RangeReadError(answer.status, answer.statusText, answer.body);
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
    const answer = await client.exec({
      disks: { [request.mount]: { disk: this.id, checkoutPaths: [...request.checkoutPaths], queueMs: request.queueMs } },
      command: request.command,
    });
    return { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr };
  }
}

/** Disk `options.disk` through Archil's SDK, its key read from the variable named `options.keyEnv` at the first call. */
export const archilDisk = (options: ArchilDiskOptions): ArchilDisk => new SdkArchilDisk(options);
