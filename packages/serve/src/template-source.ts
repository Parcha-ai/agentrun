// A template package from GitHub (POST /v2/templates/import): its source read, its ref resolved to a full commit SHA before
// anything else is read, the repository's tarball at that SHA streamed from GitHub's own hosts alone, and the package's
// folder taken out of it in memory, every entry checked as it comes. Nothing is written to disk and nothing in it runs:
// templates.ts readPackage, the one checker, reads the files kept here as it reads a bundled package's folder.
import { createGunzip } from "node:zlib";
import { invalid } from "./errors.js";
import { MAX_PACKAGE_FILES } from "./templates.js";

/** The hosts an import reads from: GitHub's API, its web host (a tree URL a person pastes) and the tarball host the API
 *  redirects to. A redirect anywhere else is refused. */
export const GITHUB_HOSTS: readonly string[] = ["github.com", "api.github.com", "codeload.github.com"];
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._@+-]{1,255}$/;
const REF = /^[A-Za-z0-9._/+-]{1,255}$/;
const SHA = /^[0-9a-f]{40}$/;
/** What one import may take: the tarball as sent, the tarball unpacked (the whole repository streams through, counted), the
 *  package's own files together and how many there are, and the time the whole read may take. The package's own limits (templates.ts) hold too. */
export const IMPORT_LIMITS = { downloadBytes: 128 << 20, unpackedBytes: 1 << 30, packageBytes: 8 << 20, files: MAX_PACKAGE_FILES, ms: 120_000 } as const;
/** How many redirects an import follows, each to GitHub's own hosts. */
const MAX_REDIRECTS = 3;

/** A package's place on GitHub: the repository, the folder in it (null, its root) and the ref asked for (null, its default
 *  branch). `id`, the package's identity here, is the source without the ref: importing it again at a new SHA replaces it. */
export type GithubSource = { owner: string; repo: string; path: string | null; ref: string | null; id: string; source: string };

const refused = (message: string) => invalid([{ field: "source", reason: "bad_format", message, expected: "github:<owner>/<repo>[/<path>][@<ref>]", example: "github:Parcha-ai/agentrun/packages/serve/templates/kyb@main" }]);

/** `text` read as a package's source: `github:<owner>/<repo>[/<path>][@<ref>]`, or a GitHub web URL of the repository or of
 *  a folder in it (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`, its ref the one segment after tree), made into
 *  the first form. Anything else is a 422 on `source`. */
export function parseSource(text: unknown): GithubSource {
  if (typeof text !== "string" || !text.trim()) throw refused("source is a GitHub package's place: github:<owner>/<repo>[/<path>][@<ref>], or its https://github.com/<owner>/<repo>/tree/<ref>/<path> URL.");
  const given = text.trim();
  let owner: string, repo: string, rest: string[], ref: string | null;
  if (/^https?:\/\//i.test(given)) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      throw refused(`${given} is not a URL.`);
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) throw refused(`A package is imported from github.com alone, over https: ${url.protocol}//${url.host} is not.`);
    if (url.search || url.hash) throw refused("A package's GitHub URL has no query or fragment.");
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    [owner = "", repo = ""] = parts;
    repo = repo.replace(/\.git$/, "");
    if (parts.length > 2 && parts[2] !== "tree") throw refused("A package's GitHub URL is the repository's, or a folder's: https://github.com/<owner>/<repo>/tree/<ref>/<path>.");
    ref = parts[2] === "tree" ? (parts[3] ?? null) : null;
    if (parts[2] === "tree" && !ref) throw refused("A /tree/ URL names its ref: https://github.com/<owner>/<repo>/tree/<ref>/<path>.");
    rest = parts.slice(4);
  } else {
    const match = /^github:([^@]+?)(?:@([^@]+))?$/.exec(given);
    if (!match) throw refused(`${given} is not a package source: github:<owner>/<repo>[/<path>][@<ref>].`);
    const parts = match[1]!.split("/");
    [owner = "", repo = ""] = parts;
    rest = parts.slice(2);
    ref = match[2] ?? null;
  }
  if (!OWNER.test(owner)) throw refused(`${JSON.stringify(owner)} is not a GitHub account's name.`);
  if (!REPO.test(repo) || repo === "." || repo === "..") throw refused(`${JSON.stringify(repo)} is not a GitHub repository's name.`);
  if (rest.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) throw refused(`The package's folder ${JSON.stringify(rest.join("/"))} is a path of plain names: no empty part, no . or ..`);
  if (ref !== null && (!REF.test(ref) || ref.split("/").some((part) => !part || part === "." || part === "..") || ref.includes(".."))) throw refused(`${JSON.stringify(ref)} is not a git ref.`);
  const path = rest.length ? rest.join("/") : null;
  const id = `github:${owner}/${repo}${path ? `/${path}` : ""}`;
  return { owner, repo, path, ref, id, source: `${id}${ref ? `@${ref}` : ""}` };
}

/** An import that GitHub refused or that broke a limit, in words a person acts on: 422 `source` (not there, private, too
 *  big, a link) or 502 github_failed (GitHub did not answer, or its rate limit). */
export class ImportRefused extends Error {
  constructor(readonly kind: "source" | "github" | "package", message: string) {
    super(message);
  }
}

/** Where an import reads GitHub from: its API's origin and the hosts it may be sent to (GitHub's own; a test's faux GitHub
 *  in place of them), a token when the server has one (its GitHub App's), and why it has none, said when GitHub limits
 *  the anonymous read. */
export type GithubReach = { api: string; hosts: readonly string[]; token?: string; anonymous?: string; signal?: AbortSignal; limits?: Partial<typeof IMPORT_LIMITS> };

/** What GitHub's 403 or 429 means for an import: its rate limit, with the token it was read with or without. */
function limited(res: Response, reach: GithubReach): ImportRefused | undefined {
  if (res.status !== 429 && !(res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return undefined;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const when = Number.isFinite(reset) && reset > 0 ? ` It resets at ${new Date(reset * 1000).toISOString()}.` : "";
  return new ImportRefused("github", reach.token
    ? `GitHub's rate limit for this server's GitHub App ran out.${when}`
    : `GitHub's rate limit for anonymous reads (60 an hour from this address) ran out, and this server read GitHub anonymously: ${reach.anonymous ?? "it has no GitHub App"}. Connect GitHub in Settings so imports read with the App's token, or try again later.${when}`);
}

/** One GET from GitHub, following its redirects only to `reach.hosts`, over the API's own protocol. */
async function githubGet(url: string, reach: GithubReach, accept: string, signal: AbortSignal): Promise<Response> {
  const protocol = new URL(reach.api).protocol;
  let at = new URL(url);
  for (let hop = 0; ; hop++) {
    if (at.protocol !== protocol || !reach.hosts.includes(at.host) || at.username || at.password) throw new ImportRefused("github", `GitHub sent the import to ${at.protocol}//${at.host}, which is not one of GitHub's own hosts (${reach.hosts.join(", ")}): refused.`);
    // The token goes to the API alone, never to a host a redirect names.
    const api = at.origin === new URL(reach.api).origin;
    let res: Response;
    try {
      res = await fetch(at, { redirect: "manual", signal, headers: { accept, "user-agent": "agentrun-serve", "x-github-api-version": "2022-11-28", ...(api && reach.token ? { authorization: `Bearer ${reach.token}` } : {}) } });
    } catch (error) {
      throw new ImportRefused("github", (error as Error).name === "TimeoutError" || signal.aborted ? `GitHub did not finish answering in ${(reach.limits?.ms ?? IMPORT_LIMITS.ms) / 1000} s.` : `GitHub could not be reached: ${(error as Error).message}.`);
    }
    if (res.status < 300 || res.status >= 400) return res;
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) throw new ImportRefused("github", `GitHub redirected the import ${hop >= MAX_REDIRECTS ? `more than ${MAX_REDIRECTS} times` : "with no Location"}.`);
    at = new URL(location, at);
  }
}

/** The full commit SHA `source`'s ref (its default branch when it names none) is at now: GitHub's answer, read before
 *  anything else, so what is imported is that one commit and its SHA is what is stored and shown. */
export async function resolveSha(source: GithubSource, reach: GithubReach, signal: AbortSignal): Promise<string> {
  const api = reach.api.replace(/\/+$/, "");
  const url = `${api}/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref ?? "HEAD")}`;
  let res = await githubGet(url, reach, "application/vnd.github.sha", signal);
  // An App token GitHub refuses for this repository (one its installation does not cover): read it anonymously instead,
  // as a public repository is, and the rest of the import with it. Only `reach` is changed.
  if (reach.token && (res.status === 401 || res.status === 404)) {
    await res.body?.cancel();
    reach.anonymous = "its GitHub App's token was refused for this repository";
    delete reach.token;
    res = await githubGet(url, reach, "application/vnd.github.sha", signal);
  }
  const text = (await res.text()).trim();
  const rate = limited(res, reach);
  if (rate) throw rate;
  if (res.status === 404 || res.status === 422) throw new ImportRefused("source", `GitHub has no ${source.ref ? `ref ${source.ref} in ` : ""}${source.owner}/${source.repo} that this server can read: it is not there, or it is private (a private repository can't be imported).`);
  if (res.status !== 200 || !SHA.test(text)) throw new ImportRefused("github", `GitHub answered ${res.status} for ${source.owner}/${source.repo}'s commit ${source.ref ?? "HEAD"}.`);
  return text;
}

/** One entry of a tar stream: its path, its type flag and its bytes (a regular file's alone). */
type TarEntry = { path: string; type: string; size: number };

/** The package's files at `sha`: the repository's tarball streamed from GitHub, unpacked as it comes, its folder
 *  `source.path` (the root when null) kept in memory by path under it; every other entry is counted and dropped. A link,
 *  a device or any other entry that is not a regular file or a folder in the package's folder refuses the import, as do a
 *  path that climbs out, a file over the package's limits, and a tarball past IMPORT_LIMITS. */
export async function fetchPackageFiles(source: GithubSource, sha: string, reach: GithubReach, signal: AbortSignal): Promise<Map<string, Buffer>> {
  const limits = { ...IMPORT_LIMITS, ...reach.limits };
  const api = reach.api.replace(/\/+$/, "");
  const res = await githubGet(`${api}/repos/${source.owner}/${source.repo}/tarball/${sha}`, reach, "application/vnd.github+json", signal);
  const rate = limited(res, reach);
  if (rate) throw (await res.body?.cancel(), rate);
  if (res.status === 404) throw (await res.body?.cancel(), new ImportRefused("source", `GitHub has no tarball of ${source.owner}/${source.repo} at ${sha} that this server can read.`));
  if (res.status !== 200 || !res.body) throw (await res.body?.cancel(), new ImportRefused("github", `GitHub answered ${res.status} for ${source.owner}/${source.repo}'s tarball.`));
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limits.downloadBytes) throw (await res.body.cancel(), new ImportRefused("source", `${source.owner}/${source.repo}'s tarball is ${declared} bytes, over the ${limits.downloadBytes} an import reads.`));
  return untarPackage(res.body, source, limits);
}

/** The tar stream `body` (gzip) unpacked as it comes, keeping the files under the archive's one top folder and
 *  `source.path`. A file outside the package is skipped unread, never held; one inside is held whole. */
async function untarPackage(body: ReadableStream<Uint8Array>, source: GithubSource, limits: typeof IMPORT_LIMITS): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const folder = source.path ? `${source.path}/` : "";
  let sent = 0;
  let unpacked = 0;
  let kept = 0;
  let found = false;
  const gunzip = createGunzip();
  const reader = body.getReader();
  // The gzip stream fed from the download, counted against its limit as it comes. A full gzip waits for its drain, or for
  // its close: once the reader below stops (a refusal), it is destroyed and drains no more, and the pump ends there.
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || gunzip.destroyed) break;
        sent += value.byteLength;
        if (sent > limits.downloadBytes) throw new ImportRefused("source", `${source.owner}/${source.repo}'s tarball is over the ${limits.downloadBytes} bytes an import reads.`);
        if (!gunzip.write(value)) await new Promise<void>((go) => {
          const on = () => { gunzip.off("drain", on); gunzip.off("close", on); go(); };
          gunzip.on("drain", on);
          gunzip.on("close", on);
        });
        if (gunzip.destroyed) break;
      }
      if (!gunzip.destroyed) gunzip.end();
    } catch (error) {
      gunzip.destroy(error as Error);
    }
  })();
  const chunks = gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  // What has been unpacked and not read yet, as chunks, joined only when a read needs more than the first holds.
  let held: Buffer[] = [];
  let heldBytes = 0;
  const fill = async (n: number): Promise<boolean> => {
    while (heldBytes < n) {
      const next = await chunks.next();
      if (next.done) return false;
      unpacked += next.value.length;
      if (unpacked > limits.unpackedBytes) throw new ImportRefused("source", `${source.owner}/${source.repo}'s tarball unpacks to over the ${limits.unpackedBytes} bytes an import reads.`);
      held.push(next.value);
      heldBytes += next.value.length;
    }
    return true;
  };
  const read = (n: number): Buffer => {
    const all = held.length === 1 ? held[0]! : Buffer.concat(held);
    held = all.length > n ? [all.subarray(n)] : [];
    heldBytes = all.length - n;
    return all.subarray(0, n);
  };
  const skip = async (n: number) => {
    while (n > 0) {
      if (!heldBytes && !(await fill(1))) throw new ImportRefused("github", "GitHub's tarball ended inside a file.");
      const step = Math.min(n, heldBytes);
      read(step);
      n -= step;
    }
  };
  const ended = () => new ImportRefused("github", "GitHub's tarball ended inside an entry.");
  let longName: string | undefined;
  let paxPath: string | undefined;
  let top: string | undefined;
  try {
    while (await fill(512)) {
      const header = read(512);
      if (header.every((byte) => byte === 0)) continue;
      const entry = headerOf(header);
      const padded = Math.ceil(entry.size / 512) * 512;
      // A pax record (x, a path past 100 bytes; g, the archive's own, its commit) or a GNU long name: small, read whole.
      if (entry.type === "x" || entry.type === "g" || entry.type === "L") {
        if (entry.size > 1 << 20) throw new ImportRefused("github", "GitHub's tarball has an extended header past what an import reads.");
        if (!(await fill(padded))) throw ended();
        const data = Buffer.from(read(padded).subarray(0, entry.size));
        if (entry.type === "x") paxPath = paxField(data, "path") ?? paxPath;
        if (entry.type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
        continue;
      }
      const path = paxPath ?? longName ?? entry.path;
      paxPath = undefined;
      longName = undefined;
      // GitHub's tarball holds one top folder, <owner>-<repo>-<short sha>/, and everything is under it.
      const parts = path.split("/");
      if (parts.length > 1 && parts.at(-1) === "") parts.pop();
      if (!parts.length || parts.some((part) => part === "" || part === "." || part === "..")) throw new ImportRefused("package", `The tarball holds ${JSON.stringify(path)}, a path that is not plain: refused.`);
      top ??= parts[0];
      if (parts[0] !== top) throw new ImportRefused("package", `The tarball holds ${JSON.stringify(path)}, outside its one top folder: refused.`);
      const inRepo = parts.slice(1).join("/");
      const mine = !folder || inRepo === source.path || inRepo.startsWith(folder);
      if (!mine) {
        await skip(padded);
        continue;
      }
      const own = folder ? (inRepo === source.path ? "" : inRepo.slice(folder.length)) : inRepo;
      if (entry.type === "5") {
        if (!own) found = true;
        await skip(padded);
        continue;
      }
      if (!own) throw new ImportRefused("source", `${source.path ?? "The root"} in ${source.owner}/${source.repo} is ${entry.type === "2" ? "a symbolic link" : "a file"}, not a package's folder.`);
      if (entry.type !== "0" && entry.type !== "\0" && entry.type !== "7") throw new ImportRefused("package", `${own} is ${entry.type === "2" ? "a symbolic link" : entry.type === "1" ? "a hard link" : "not a regular file or a folder"}: a package holds files and folders alone, so the import was refused.`);
      found = true;
      kept += entry.size;
      if (kept > limits.packageBytes) throw new ImportRefused("package", `The package's files are over the ${limits.packageBytes} bytes an import keeps.`);
      if (files.size >= limits.files) throw new ImportRefused("package", `The package holds over ${limits.files} files.`);
      if (!(await fill(padded))) throw ended();
      files.set(own, Buffer.from(read(padded).subarray(0, entry.size)));
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    gunzip.destroy();
    await pump.catch(() => undefined);
    if (error instanceof ImportRefused) throw error;
    throw new ImportRefused("github", `GitHub's tarball could not be read: ${(error as Error).message}.`);
  }
  await pump;
  if (!found) throw new ImportRefused("source", `${source.owner}/${source.repo} has no folder ${source.path ?? "(its root)"} at that commit.`);
  return files;
}

/** A ustar header's path (its prefix and name), type flag and size. A size in base-256 or past 8 GiB is refused. */
function headerOf(header: Buffer): TarEntry {
  const field = (from: number, length: number) => header.subarray(from, from + length).toString("utf8").replace(/\0.*$/s, "");
  const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
  if (Number.parseInt(field(148, 8).trim(), 8) !== sum) throw new ImportRefused("github", "GitHub's tarball has a header whose checksum does not match.");
  if (header[124]! & 0x80) throw new ImportRefused("package", "The tarball holds a file too big for an import.");
  const size = Number.parseInt(field(124, 12).trim() || "0", 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new ImportRefused("github", "GitHub's tarball has a header with no size.");
  const name = field(0, 100);
  const prefix = field(257, 6).startsWith("ustar") ? field(345, 155) : "";
  return { path: prefix ? `${prefix}/${name}` : name, type: String.fromCharCode(header[156] || 48), size };
}

/** A pax extended header's `key` record, or undefined. */
function paxField(data: Buffer, key: string): string | undefined {
  let at = 0;
  let found: string | undefined;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(at, space).toString("utf8"), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === key) found = record.slice(eq + 1);
    at += length;
  }
  return found;
}
