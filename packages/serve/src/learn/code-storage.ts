// The code.storage learning store (learn/store.ts): agent `agentId`'s learning as one code.storage repository,
// agentrun-<server id>-<agent id>, over code.storage's REST API (https://api.<org>.code.storage/api/v1/), off unless
// this process's start is keyed (store-of.ts). Each call carries a token of its own: an ES256 JWT signed here with the
// org's key, naming the repository and the scopes it needs, for five minutes. The API takes the repository from the
// token alone, so a call reaches no other one. The key itself never leaves this process.
//
// What each op is:
// - head: main's newest commit (GET repos/commits?branch=main&limit=1); a repository or main not there is null;
// - read: the paths at a commit (GET repos/files), then each body (GET repos/file), in parallel;
// - log: main's history, a page at a time, from the commit asked (every commit here is on main's first-parent line);
// - diff: GET repos/diff of the commit, each file's raw diff cut to its hunks;
// - save: the preconditions and markers read at `old` (each a read at that commit), then ONE commit
//   (POST repos/commit-pack) on main with expected_target_sha `old` (40 zeros before main), the marker file in it. A stale `old` is a 409
//   conflict, nothing written; a tree the same as `old`'s is refused "no changes to commit" (unchanged). The first
//   save makes the repository (POST repos; one there already is fine) and commits with no expected head, after reading
//   main is not there (code.storage takes no compare and swap on a branch not made yet);
// - remove: DELETE repos/delete (a 404 is done). The next save makes the repository again, empty. Never restore_commit:
//   it keeps the old commits reachable, so it is no erasure.
import { createHash, createPrivateKey, type KeyObject, randomUUID, sign } from "node:crypto";
import { CODE_STORAGE_ENV, COMMIT, FolderUnreadable, IDENTITY, type LearningStore, MARKER_KEY, PATCH_CAP, purgedMarker, runMarker, type Saved, type StoreCommit, type StoreDiffFile, type StoreFile, type StoreSave } from "./store.js";
import type { CodeStorageSettings } from "./store-of.js";

/** How long a token is good for. */
const TOKEN_SECONDS = 300;
/** A page of history. */
const PAGE = 100;
/** How long one call may take. */
const CALL_TIMEOUT_MS = 30_000;
/** How many bodies are read at once. */
const PARALLEL = 16;
/** The head a commit names for a branch not made yet. */
const NO_COMMIT = "0".repeat(40);

type Scope = "git:read" | "git:write" | "repo:write";

/** The repository of agent `agentId` on server `serverId`: agentrun-<server id>-<agent id> for an id of letters,
 *  digits, dashes and underscores (at most 64); any other is `h-<its first 21 such characters>-<24 hex digits of its
 *  SHA-256>`, so no id's name is another's. */
export function repoIdOf(serverId: string, agentId: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(agentId) && !/^h-.*-[0-9a-f]{24}$/.test(agentId)) return `agentrun-${serverId}-${agentId}`;
  return `agentrun-${serverId}-h-${agentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 21)}-${createHash("sha256").update(agentId).digest("hex").slice(0, 24)}`;
}

/** A call code.storage answered with a failure: its HTTP status and what its body said. */
class CodeStorageFailed extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(what: string, status: number, body: unknown) {
    const said = typeof body === "object" && body !== null ? ((body as { error?: unknown }).error ?? (body as { result?: { message?: unknown } }).result?.message ?? (body as { message?: unknown }).message) : body;
    super(`code.storage's ${what} answered ${status}${said ? `: ${String(said).slice(0, 300)}` : ""}`);
    this.name = "CodeStorageFailed";
    this.status = status;
    this.body = body;
  }
}

/** A commit-pack's answer: its commit and its ref update. */
type Ack = { commit?: { commit_sha?: string } | null; result?: { old_sha?: string; new_sha?: string; success?: boolean; status?: string; message?: string } };
type CommitView = { sha: string; parent_shas?: string[]; message?: string; date?: string; committer_date?: string; author_date?: string };

/** Agent `agentId`'s learning store on code.storage, by `settings`. */
export function codeStorageLearningStore(settings: CodeStorageSettings, agentId: string): LearningStore {
  // The key read when first signed with, so making a store (every run of an agent makes its own) never throws: a key
  // that is no key fails each call, as a store that can't be reached does.
  let key: KeyObject | undefined;
  const keyOf = (): KeyObject => {
    if (key) return key;
    try {
      return (key = typeof settings.key === "string" ? createPrivateKey(settings.key) : settings.key);
    } catch {
      throw new FolderUnreadable(false, `${CODE_STORAGE_ENV.key} is not a private key code.storage's tokens can be signed with: nothing learned is read or written until it is`);
    }
  };
  const base = `${(settings.apiUrl ?? `https://api.${settings.name}.code.storage`).replace(/\/+$/, "")}/api/v1/`;
  const doFetch = settings.fetch ?? fetch;
  let repo: Promise<string> | undefined;
  const repoId = () => (repo ??= settings.serverId().then((id) => repoIdOf(id, agentId)));

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  async function token(scopes: readonly Scope[]): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: "ES256", typ: "JWT" });
    const body = b64({ iss: settings.name, sub: "@agentrun/serve", repo: await repoId(), scopes, iat: now, exp: now + TOKEN_SECONDS });
    const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: keyOf(), dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${head}.${body}.${signature}`;
  }

  /** One call: its response, whatever its status. A network failure is the store unavailable. */
  async function call(what: string, method: string, path: string, scopes: readonly Scope[], init: { query?: Record<string, string | undefined>; body?: BodyInit; type?: string } = {}): Promise<Response> {
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, value);
    const headers: Record<string, string> = { authorization: `Bearer ${await token(scopes)}`, "code-storage-agent": "agentrun-serve" };
    if (init.type) headers["content-type"] = init.type;
    try {
      return await doFetch(url, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (error) {
      throw new FolderUnreadable(false, `the agent's learning on code.storage can't be reached right now (${what}): ${(error as Error)?.message ?? error}`);
    }
  }
  const bodyOf = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  /** A read's JSON, or undefined on a 404 (no repository, no main, no such commit or path). */
  async function getJson<T>(what: string, path: string, query: Record<string, string | undefined>): Promise<T | undefined> {
    const response = await call(what, "GET", path, ["git:read"], { query });
    if (response.status === 404) return void (await response.body?.cancel());
    const body = await bodyOf(response);
    if (!response.ok) throw unavailable(new CodeStorageFailed(what, response.status, body));
    return body as T;
  }
  const unavailable = (error: Error) => new FolderUnreadable(false, `the agent's learning on code.storage can't be read right now: ${error.message}`);

  const commitOf = (view: CommitView): StoreCommit => ({ sha: view.sha, parent: view.parent_shas?.[0] ?? null, at: view.date ?? view.committer_date ?? view.author_date ?? "", message: view.message ?? "" });
  const holds = async (commit: string): Promise<CommitView | undefined> => (await getJson<{ commit: CommitView }>("commit", "repos/commit", { sha: commit }))?.commit;

  async function head(): Promise<string | null> {
    const page = await getJson<{ commits: CommitView[] }>("history", "repos/commits", { branch: "main", limit: "1" });
    return page?.commits[0]?.sha ?? null;
  }

  /** The paths at `ref` (a commit), or undefined when the store does not hold it. */
  async function paths(ref: string): Promise<{ path: string; mode: StoreFile["mode"] }[] | undefined> {
    const out: { path: string; mode: StoreFile["mode"] }[] = [];
    let cursor: string | undefined;
    do {
      const page = await getJson<{ entries?: { path: string; type?: string; mode?: string }[]; paths?: string[]; next_cursor?: string | null; has_more?: boolean }>("files", "repos/files", { ref, recursive: "true", ...(cursor ? { cursor } : {}) });
      if (!page) return undefined;
      const entries = page.entries ?? (page.paths ?? []).map((path) => ({ path, type: "blob", mode: "100644" }));
      for (const entry of entries) {
        if (entry.type !== undefined && entry.type !== "blob" && entry.type !== "symlink") continue;
        const mode = entry.mode === "100755" || entry.mode === "120000" ? entry.mode : entry.type === "symlink" ? "120000" : "100644";
        out.push({ path: entry.path, mode });
      }
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  /** Each of `files`' bodies at `ref`, PARALLEL at a time. */
  async function bodies(ref: string, files: readonly { path: string; mode: StoreFile["mode"] }[]): Promise<StoreFile[] | undefined> {
    const out: (StoreFile | undefined)[] = new Array(files.length);
    let next = 0;
    let gone = false;
    const worker = async () => {
      while (next < files.length && !gone) {
        const i = next++;
        const file = files[i]!;
        const response = await call("file", "GET", "repos/file", ["git:read"], { query: { path: file.path, ref } });
        if (response.status === 404) {
          await response.body?.cancel();
          gone = true;
          return;
        }
        if (!response.ok) throw unavailable(new CodeStorageFailed("file", response.status, await bodyOf(response)));
        out[i] = { path: file.path, mode: file.mode, body: Buffer.from(await response.arrayBuffer()) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
    return gone ? undefined : (out as StoreFile[]);
  }

  async function read(ref: string, only?: readonly string[]): Promise<StoreFile[] | undefined> {
    if (!COMMIT.test(ref)) throw new Error(`${JSON.stringify(ref)} is not a commit`);
    const all = await paths(ref);
    if (!all) return undefined;
    const wanted = only ? new Set(only) : undefined;
    return bodies(ref, wanted ? all.filter((file) => wanted.has(file.path)) : all);
  }

  /** main's history a page at a time, newest first, those that changed `path` alone when named. */
  async function* history(path?: string): AsyncGenerator<StoreCommit> {
    let cursor: string | undefined;
    do {
      const page = await getJson<{ commits: CommitView[]; next_cursor?: string | null; has_more?: boolean }>("history", "repos/commits", { branch: "main", limit: String(PAGE), ...(path ? { path } : {}), ...(cursor ? { cursor } : {}) });
      if (!page) return;
      for (const view of page.commits) yield commitOf(view);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
  }

  async function log(ref: string, options: { limit?: number; path?: string } = {}): Promise<StoreCommit[] | undefined> {
    if (!COMMIT.test(ref)) throw new Error(`${JSON.stringify(ref)} is not a commit`);
    const limit = options.limit && options.limit > 0 ? options.limit : Infinity;
    const own = await holds(ref);
    if (!own) return undefined;
    if (limit === 1 && !options.path) return [commitOf(own)];
    // The commits on main newer than `ref`, which its own history leaves out.
    const newer = new Set<string>();
    if (!options.path) {
      const out: StoreCommit[] = [];
      let found = false;
      for await (const commit of history()) {
        if (!found && commit.sha !== ref) continue;
        found = true;
        out.push(commit);
        if (out.length >= limit) break;
      }
      return found ? out : [commitOf(own)];
    }
    for await (const commit of history()) {
      if (commit.sha === ref) break;
      newer.add(commit.sha);
    }
    const out: StoreCommit[] = [];
    for await (const commit of history(options.path)) {
      if (newer.has(commit.sha)) continue;
      out.push(commit);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function diff(commit: string): Promise<StoreDiffFile[] | undefined> {
    if (!COMMIT.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
    const got = await getJson<{ files?: { path: string; state?: string; raw?: string; bytes?: number }[]; filtered_files?: { path: string; state?: string }[] }>("diff", "repos/diff", { sha: commit });
    if (!got) return undefined;
    const status = (state: string | undefined): StoreDiffFile["status"] => (state === "added" || state === "deleted" ? state : "modified");
    const out: StoreDiffFile[] = [];
    for (const file of got.files ?? []) {
      const raw = file.raw ?? "";
      const at = raw.startsWith("@@") ? 0 : raw.indexOf("\n@@");
      const patch = at < 0 ? "" : raw.slice(at === 0 ? 0 : at + 1);
      out.push(Buffer.byteLength(patch, "utf8") > PATCH_CAP ? { path: file.path, status: status(file.state), withheld: "too_large" } : { path: file.path, status: status(file.state), patch });
    }
    for (const file of got.filtered_files ?? []) out.push({ path: file.path, status: status(file.state), withheld: "too_large" });
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** The bytes at `path` on `commit`, or undefined when it holds none there. */
  async function fileAt(commit: string, path: string): Promise<Buffer | undefined> {
    const response = await call("file", "GET", "repos/file", ["git:read"], { query: { path, ref: commit } });
    if (response.status === 404) return void (await response.body?.cancel());
    if (!response.ok) throw unavailable(new CodeStorageFailed("file", response.status, await bodyOf(response)));
    return Buffer.from(await response.arrayBuffer());
  }
  /** The newest commit that added marker `path`. */
  const addedBy = async (old: string, path: string): Promise<string> => (await log(old, { path, limit: 1 }))?.[0]?.sha ?? old;

  async function save(save: StoreSave): Promise<Saved> {
    for (const markerKey of [save.run, save.purged]) if (markerKey !== undefined && !MARKER_KEY.test(markerKey)) throw new Error(`${JSON.stringify(markerKey)} is not a marker's key`);
    const now = await head();
    if (now !== save.old) return { stale: now };
    const old = save.old;
    if (old) {
      for (const marker of [...(save.run ? [runMarker(save.run), purgedMarker(save.run)] : []), ...(save.purged ? [purgedMarker(save.purged)] : [])]) {
        if ((await fileAt(old, marker)) !== undefined) return { already: await addedBy(old, marker) };
      }
    }
    // The preconditions, each read at `old`; the commit's compare and swap on `old` keeps them true when it lands.
    const absent: string[] = [];
    const same: string[] = [];
    let seed: string | undefined;
    await Promise.all([
      ...(save.absent ?? []).map(async (path) => {
        if (old && (await fileAt(old, path)) !== undefined) absent.push(path);
      }),
      ...(save.same ?? []).map(async ({ commit, path }) => {
        if (!(await holds(commit))) return void same.push(path);
        const [was, is] = await Promise.all([fileAt(commit, path), old ? fileAt(old, path) : undefined]);
        if (!(was === undefined ? is === undefined : is !== undefined && was.equals(is))) same.push(path);
      }),
      ...(save.seed !== undefined ? [(async () => {
        if (!(await holds(save.seed!))) seed = save.seed;
      })()] : []),
    ]);
    if (absent.length || same.length || seed !== undefined) return { refused: { absent: absent.sort(), same: same.sort(), ...(seed !== undefined ? { seed } : {}) } };
    if (!old) {
      const made = await call("repository", "POST", "repos", ["repo:write"], { body: JSON.stringify({ default_branch: "main" }), type: "application/json" });
      if (!made.ok && made.status !== 409) throw unavailable(new CodeStorageFailed("repository", made.status, await bodyOf(made)));
      await made.body?.cancel();
    }
    const markers = [...(save.run ? [runMarker(save.run)] : []), ...(save.purged ? [purgedMarker(save.purged)] : [])];
    const writes = [...save.writes, ...markers.map((path) => ({ path, text: "" }))];
    const blobs = writes.map((write) => ({ ...write, id: randomUUID() }));
    const metadata = {
      target_branch: "main",
      commit_message: save.message,
      author: { name: IDENTITY.name, email: IDENTITY.email },
      // The head it read, or 40 zeros for main not made yet: a first save racing another is stale too, never a second root.
      expected_target_sha: old ?? NO_COMMIT,
      files: [...(save.deletes ?? []).filter((path) => !writes.some((write) => write.path === path)).map((path) => ({ path, operation: "delete" })), ...blobs.map(({ path, id }) => ({ path, content_id: id, operation: "upsert", mode: "100644" }))],
    };
    const lines = [JSON.stringify({ metadata }), ...blobs.map(({ id, text }) => JSON.stringify({ blob_chunk: { content_id: id, data: Buffer.from(text, "utf8").toString("base64"), eof: true } }))];
    const response = await call("commit", "POST", "repos/commit-pack", ["git:write"], { body: `${lines.join("\n")}\n`, type: "application/x-ndjson" });
    const ack = (await bodyOf(response)) as Ack;
    const status = typeof ack === "object" && ack !== null ? ack.result?.status : undefined;
    const message = typeof ack === "object" && ack !== null ? (ack.result?.message ?? "") : "";
    if (response.status === 409 || status === "conflict") return { stale: await head() };
    if (status === "precondition_failed" && /no changes/i.test(message)) return { unchanged: true };
    const sha = ack?.commit?.commit_sha ?? ack?.result?.new_sha;
    if (!response.ok || ack?.result?.success === false || !sha || !COMMIT.test(sha)) throw unavailable(new CodeStorageFailed("commit", response.status, ack));
    return { saved: sha };
  }

  async function remove(): Promise<void> {
    const response = await call("delete", "DELETE", "repos/delete", ["repo:write"]);
    const body = await bodyOf(response);
    if (response.ok || response.status === 404 || response.status === 409) return;
    throw unavailable(new CodeStorageFailed("delete", response.status, body));
  }

  return { id: `code.storage:${settings.name}:${agentId}`, head, read, log, diff, save, remove };
}
