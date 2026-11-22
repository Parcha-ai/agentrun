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
//   a listing gives each commit's subject line alone, so each message is read whole (GET repos/commit), once a commit;
// - diff: GET repos/diff of the commit, each file's raw diff cut to its hunks;
// - save: the preconditions and markers read at `old` (each a read at that commit), then ONE commit
//   (POST repos/commit-pack) on main with expected_target_sha `old` (40 zeros before main), the marker file in it. A stale `old` is a 409
//   conflict, nothing written; a tree the same as `old`'s is refused "no changes to commit" (unchanged). The first
//   save makes the repository (POST repos; one there already is fine) and commits with no expected head, after reading
//   main is not there (code.storage takes no compare and swap on a branch not made yet);
// - rewrite (a run's purge): code.storage rewrites no history, so the chain is built in the agent's NEXT repository
//   generation (agentrun-<server id>-<agent id>-g<N+1>, one commit-pack a commit), then the agent's generation (a setting
//   of the server's store, `generations`) flips from N to N+1 by compare and swap, and g<N> is deleted. A build cut short
//   leaves only g<N+1>, never reached: the next rewrite or reset deletes it by its exact id first;
// - remove: a reset flips to the next generation the same way (no repository made: the next save makes it), so no
//   read ever sees a store half gone; an erasure deletes g0 through g<N+1> by their exact ids (a 404 is done) and drops
//   the agent's generation. A generation the flip left behind (its delete failed) is named in the setting and deleted
//   by the next call. Never restore_commit: it keeps the old commits reachable, so it is no erasure. No call lists
//   repositories.
import { createHash, createPrivateKey, type KeyObject, randomUUID, sign } from "node:crypto";
import { type ChainCommit, CODE_STORAGE_ENV, COMMIT, FolderUnreadable, IDENTITY, type LearningStore, MARKER_KEY, MOVED_FILE, PATCH_CAP, purgedMarker, type Rewritten, runMarker, runOfKey, type Saved, type StoreCommit, type StoreDiffFile, type StoreFile, type StoreSave } from "./store.js";
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

/** What a token lets its call do. */
export type Scope = "git:read" | "git:write" | "repo:write";

/** A repository id this server may create, read, write or delete: `agentrun-`, a server id (12 hex digits, archil-
 *  settings.ts serverIdOf), then letters, digits, dashes and underscores. The org's other repositories are never touched:
 *  every call checks the id its token names is its own server's (repoToken), and no call lists repositories or deletes
 *  any but one agent's, by its exact id. */
const AGENTRUN_REPO = /^agentrun-[0-9a-f]{12}-[A-Za-z0-9_-]{1,160}$/;

/** A repository id refused before any request goes out: one not of this server's agents (AGENTRUN_REPO), or a server
 *  id that can't make one. */
export class RepoIdRefused extends Error {
  override readonly name = "RepoIdRefused";
}

/** `id`, when it is a repository id this server may touch (AGENTRUN_REPO); else RepoIdRefused. */
export function agentrunRepo(id: string): string {
  if (typeof id !== "string" || !AGENTRUN_REPO.test(id)) throw new RepoIdRefused(`code.storage repository ${JSON.stringify(id)} is not one of this server's agents' (agentrun-...): nothing is sent for it`);
  return id;
}

/** The repository of agent `agentId` on server `serverId` (12 hex digits; else RepoIdRefused) at its generation
 *  `generation`: agentrun-<server id>-<agent id>-g<generation> for an agent id of letters, digits, dashes and
 *  underscores (at most 64); any other (empty, a slash, a dot, longer) is `h-<its first 21 such characters>-<24 hex
 *  digits of its SHA-256>`, so no id's name is another's and none leaves agentrun-. The generation is the id's last
 *  part, so no agent's generation is another agent's id. */
export function repoIdOf(serverId: string, agentId: string, generation = 0): string {
  if (typeof serverId !== "string" || !/^[0-9a-f]{12}$/.test(serverId)) throw new RepoIdRefused(`a code.storage repository is named by this server's id, and ${JSON.stringify(serverId)} is not one: nothing is sent`);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RepoIdRefused(`${JSON.stringify(generation)} is no repository generation: nothing is sent`);
  const part = /^[A-Za-z0-9_-]{1,64}$/.test(agentId) && !/^h-.*-[0-9a-f]{24}$/.test(agentId) ? agentId : `h-${String(agentId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 21)}-${createHash("sha256").update(String(agentId)).digest("hex").slice(0, 24)}`;
  return agentrunRepo(`agentrun-${serverId}-${part}-g${generation}`);
}

/** A token for repository `repo` with `scopes`, as server `serverId` signs one with org `org.name`'s key (`org.key()`,
 *  read only after the id is checked): the one place a repository id is sent (each call names its repository by its
 *  token alone), so the id is checked here and no request goes out for any other: it is one of this server's own agents'
 *  (agentrun-<serverId>-..., agentrunRepo), never another server's. Signed by the key's own kind, as code.storage's SDK
 *  chooses: an EC key ES256, an RSA key RS256, an Ed25519 key EdDSA. */
export function repoToken(org: { name: string; key: () => KeyObject }, serverId: string, repo: string, scopes: readonly Scope[]): string {
  if (typeof serverId !== "string" || !/^[0-9a-f]{12}$/.test(serverId) || !agentrunRepo(repo).startsWith(`agentrun-${serverId}-`)) throw new RepoIdRefused(`code.storage repository ${JSON.stringify(repo)} is not one of this server's (${JSON.stringify(serverId)}) agents': nothing is sent for it`);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const key = org.key();
  const kind = key.asymmetricKeyType;
  const alg = kind === "rsa" ? "RS256" : kind === "ed25519" ? "EdDSA" : "ES256";
  const head = b64({ alg, typ: "JWT" });
  const body = b64({ iss: org.name, sub: "@agentrun/serve", repo, scopes, iat: now, exp: now + TOKEN_SECONDS });
  const data = Buffer.from(`${head}.${body}`);
  const signature = (kind === "ed25519" ? sign(null, data, key) : kind === "rsa" ? sign("sha256", data, key) : sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })).toString("base64url");
  return `${head}.${body}.${signature}`;
}

/** Which repository generation an agent's learning is on (`n`), and those a flip left to delete (`drop`). */
export type Generation = { n: number; drop?: number[] };
/** Each agent's repository generation, kept by the server's store (store-of.ts learningGenerations) where its runners
 *  read it too: `set` replaces `was` with `now` by compare and swap (false: it changed since, nothing written). */
export interface Generations {
  get(agentId: string): Promise<Generation>;
  set(agentId: string, was: Generation, now: Generation): Promise<boolean>;
  drop(agentId: string): Promise<void>;
}
/** Generations kept in this process alone, one set for each settings given none (tests, the live contract suite). */
const inMemory = new WeakMap<object, Generations>();
const kept = (settings: object): Generations => {
  let one = inMemory.get(settings);
  if (!one) inMemory.set(settings, (one = memoryGenerations()));
  return one;
};
function memoryGenerations(): Generations {
  const kept = new Map<string, Generation>();
  const same = (a: Generation, b: Generation) => JSON.stringify(a) === JSON.stringify(b);
  return {
    get: async (agentId) => kept.get(agentId) ?? { n: 0 },
    set: async (agentId, was, now) => same(kept.get(agentId) ?? { n: 0 }, was) && Boolean(kept.set(agentId, now)),
    drop: async (agentId) => void kept.delete(agentId),
  };
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

/** The store unavailable, for `error`. */
const unavailable = (error: Error) => new FolderUnreadable(false, `the agent's learning on code.storage can't be read right now: ${error.message}`);

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
  const generations = settings.generations ?? kept(settings);
  let server: Promise<string> | undefined;
  /** Each commit's whole message, by its id, as read by itself (on's whole()). */
  const messages = new Map<string, string>();
  const idOf = async (n: number) => repoIdOf(await (server ??= settings.serverId()), agentId, n);

  /** The ops on one repository, `repo`. */
  function on(repo: string) {
    /** Every call's token (repoToken), for this store's own server id. */
    const token = async (scopes: readonly Scope[]): Promise<string> => repoToken({ name: settings.name, key: keyOf }, await (server ??= settings.serverId()), repo, scopes);

    /** One call: its response, whatever its status. A network failure is the store unavailable, and so is a redirect:
     *  no call follows one (redirect "error"), so the bearer token never travels to another place. */
    async function call(what: string, method: string, path: string, scopes: readonly Scope[], init: { query?: Record<string, string | undefined>; body?: BodyInit; type?: string } = {}): Promise<Response> {
      const url = new URL(path, base);
      for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, value);
      const headers: Record<string, string> = { authorization: `Bearer ${await token(scopes)}`, "code-storage-agent": "agentrun-serve" };
      if (init.type) headers["content-type"] = init.type;
      try {
        return await doFetch(url, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
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

    /** `commits` with each one's whole message: a listing gives its subject line alone (no body, no trailers), so each
     *  is read by itself (GET repos/commit), PARALLEL at a time, and kept (`messages`: a commit never changes). One the
     *  store no longer holds (a reset or purge since) is undefined. */
    async function whole(commits: StoreCommit[]): Promise<StoreCommit[] | undefined> {
      let next = 0;
      let gone = false;
      const worker = async () => {
        while (next < commits.length && !gone) {
          const { sha } = commits[next++]!;
          if (messages.has(sha)) continue;
          const view = await holds(sha);
          if (!view) return void (gone = true);
          messages.set(sha, view.message ?? "");
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, commits.length) }, worker));
      return gone ? undefined : commits.map((commit) => ({ ...commit, message: messages.get(commit.sha)! }));
    }

    async function log(ref: string, options: { limit?: number; path?: string } = {}): Promise<StoreCommit[] | undefined> {
      if (!COMMIT.test(ref)) throw new Error(`${JSON.stringify(ref)} is not a commit`);
      const limit = options.limit && options.limit > 0 ? options.limit : Infinity;
      const own = await holds(ref);
      if (!own) return undefined;
      messages.set(own.sha, own.message ?? "");
      if (limit === 1 && !options.path) return [commitOf(own)];
      return whole(await listed(ref, own, limit, options.path));
    }

    /** log's commits as listed (each message its subject line alone). */
    async function listed(ref: string, own: CommitView, limit: number, path: string | undefined): Promise<StoreCommit[]> {
      // The commits on main newer than `ref`, which its own history leaves out.
      const newer = new Set<string>();
      if (!path) {
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
      for await (const commit of history(path)) {
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
      // The API sends git's raw letter (A, M, D, T, U; R and C with a score): A added, D deleted, any other modified.
      const status = (state: string | undefined): StoreDiffFile["status"] => (state?.[0] === "A" ? "added" : state?.[0] === "D" ? "deleted" : "modified");
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

    async function save(save: StoreSave, still: () => Promise<boolean>): Promise<Saved | { moved: true }> {
      if (save.run !== undefined && !MARKER_KEY.test(save.run)) throw new Error(`${JSON.stringify(save.run)} is not a marker's key`);
      const now = await head();
      if (now !== save.old) return { stale: now };
      const old = save.old;
      if (old) {
        for (const marker of save.run ? [runMarker(save.run), purgedMarker(runOfKey(save.run))] : []) {
          if ((await fileAt(old, marker)) !== undefined) return { already: await addedBy(old, marker) };
        }
      }
      // The preconditions, each read at `old`; the commit's compare and swap on `old` keeps them true when it lands.
      const absent: string[] = [];
      const same: string[] = [];
      let seed: string | undefined;
      let fenced = false;
      await Promise.all([
        // A rewrite fenced this main (MOVED_FILE): the agent is moving to its next generation, so nothing lands here.
        ...(old ? [(async () => {
          fenced = (await fileAt(old, MOVED_FILE)) !== undefined;
        })()] : []),
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
      if (fenced) return { moved: true };
      if (absent.length || same.length || seed !== undefined) return { refused: { absent: absent.sort(), same: same.sort(), ...(seed !== undefined ? { seed } : {}) } };
      if (!old) {
        // The repository made only while the agent is still on its generation: a reset or purge flipped since moves on.
        if (!(await still())) return { moved: true };
        await make();
      }
      const writes = [...save.writes, ...(save.run ? [{ path: runMarker(save.run), text: "" }] : [])].map(({ path, text }) => ({ path, mode: "100644", body: Buffer.from(text, "utf8") }));
      const done = await pack(save.message, old, writes, (save.deletes ?? []).filter((path) => !writes.some((write) => write.path === path)));
      if ("stale" in done) return { stale: await head() };
      return done;
    }

    /** The repository made (one there already is fine). */
    async function make(): Promise<void> {
      const made = await call("repository", "POST", "repos", ["repo:write"], { body: JSON.stringify({ default_branch: "main" }), type: "application/json" });
      if (!made.ok && made.status !== 409) throw unavailable(new CodeStorageFailed("repository", made.status, await bodyOf(made)));
      await made.body?.cancel();
    }

    /** ONE commit on main (POST repos/commit-pack) from `old` (expected_target_sha; 40 zeros for main not made yet: a
     *  first commit racing another is stale too, never a second root): `writes` upserted, `deletes` deleted. */
    async function pack(message: string, old: string | null, writes: readonly { path: string; mode: string; body: Buffer }[], deletes: readonly string[]): Promise<{ saved: string } | { stale: true } | { unchanged: true }> {
      const blobs = writes.map((write) => ({ ...write, id: randomUUID() }));
      const metadata = {
        target_branch: "main",
        commit_message: message,
        author: { name: IDENTITY.name, email: IDENTITY.email },
        expected_target_sha: old ?? NO_COMMIT,
        files: [...deletes.map((path) => ({ path, operation: "delete" })), ...blobs.map(({ path, id, mode }) => ({ path, content_id: id, operation: "upsert", mode }))],
      };
      const lines = [JSON.stringify({ metadata }), ...blobs.map(({ id, body }) => JSON.stringify({ blob_chunk: { content_id: id, data: body.toString("base64"), eof: true } }))];
      const response = await call("commit", "POST", "repos/commit-pack", ["git:write"], { body: `${lines.join("\n")}\n`, type: "application/x-ndjson" });
      const ack = (await bodyOf(response)) as Ack;
      const status = typeof ack === "object" && ack !== null ? ack.result?.status : undefined;
      const said = typeof ack === "object" && ack !== null ? (ack.result?.message ?? "") : "";
      if (response.status === 409 || status === "conflict") return { stale: true };
      if (status === "precondition_failed" && /no changes/i.test(said)) return { unchanged: true };
      const sha = ack?.commit?.commit_sha ?? ack?.result?.new_sha;
      if (!response.ok || ack?.result?.success === false || !sha || !COMMIT.test(sha)) throw unavailable(new CodeStorageFailed("commit", response.status, ack));
      return { saved: sha };
    }

    /** The repository deleted, by its exact id (a 404 is done). */
    async function drop(): Promise<void> {
      const response = await call("delete", "DELETE", "repos/delete", ["repo:write"]);
      const body = await bodyOf(response);
      if (response.ok || response.status === 404) return;
      throw unavailable(new CodeStorageFailed("delete", response.status, body));
    }

    return { head, read, log, diff, save, make, pack, drop };
  }

  /** The agent's generation and the ops on its repository; the generations a flip left behind deleted first (one that
   *  can't be deleted now stays named, for the next call). */
  async function current(strict = false): Promise<{ at: Generation; ops: ReturnType<typeof on> }> {
    let at = await generations.get(agentId);
    if (at.drop?.length) {
      // `strict` (tidy): a generation that can't be deleted now throws, retryable, rather than staying named.
      const left = (await Promise.all(at.drop.map(async (g) => (await on(await idOf(g)).drop().then(() => true, (error: unknown) => (strict ? Promise.reject(error) : false))) ? [] : [g]))).flat();
      const now = { n: at.n, ...(left.length ? { drop: left } : {}) };
      if (left.length < at.drop.length) at = (await generations.set(agentId, at, now)) ? now : await generations.get(agentId);
    }
    return { at, ops: on(await idOf(at.n)) };
  }
  /** The agent moved from generation `at` to `to` by compare and swap (false: it changed since), then `old` deleted. */
  async function flip(at: Generation, to: number, old: number[]): Promise<boolean> {
    const moved = { n: to, drop: [...(at.drop ?? []), ...old] };
    if (!(await generations.set(agentId, at, moved))) return false;
    for (const g of moved.drop) await on(await idOf(g)).drop();
    await generations.set(agentId, moved, { n: to });
    return true;
  }

  async function rewrite(old: string, build: (commit: (one: ChainCommit) => Promise<string>) => Promise<string>): Promise<Rewritten> {
    const { at, ops } = await current();
    const now = await ops.head();
    if (now !== old) return { stale: now };
    // The next generation: a build cut short left it, never reached; it starts again empty.
    const next = on(await idOf(at.n + 1));
    await next.drop();
    await next.make();
    let tree = new Map<string, Buffer>();
    const tip = await build(async (one) => {
      const files = new Map(one.files.map((file) => [file.path, file.body]));
      const writes = one.files.filter((file) => !tree.get(file.path)?.equals(file.body));
      const done = await next.pack(one.message, one.parent, writes, [...tree.keys()].filter((path) => !files.has(path)));
      if (!("saved" in done)) throw unavailable(new Error(`the next repository's commit was ${"stale" in done ? "stale" : "no change"}`));
      tree = files;
      return done.saved;
    });
    // The old main fenced by compare and swap on `old`: a save that landed since makes this stale, and one after it is
    // refused (MOVED_FILE), so no save lands in the old repository reported saved and is then deleted with it.
    const fence = await ops.pack("host: moving to the next generation", old, [{ path: MOVED_FILE, mode: "100644", body: Buffer.from(`${at.n + 1}\n`, "utf8") }], []);
    // (`unchanged`: a rewrite cut short fenced it already.)
    if (!("stale" in fence) && (await flip(at, at.n + 1, [at.n]))) return { saved: tip };
    // A reset moved past it: the chain built is no generation's.
    if ((await generations.get(agentId)).n !== at.n + 1) await next.drop();
    return { stale: await (await current()).ops.head() };
  }

  async function remove({ erase = false }: { erase?: boolean } = {}): Promise<void> {
    if (erase) {
      // Every generation the agent ever had, by its exact id: none is above the next one a build may have left.
      const { n, drop = [] } = await generations.get(agentId);
      for (let g = 0; g <= Math.max(n, ...drop) + 1; g++) await on(await idOf(g)).drop();
      return generations.drop(agentId);
    }
    // N+2, not N+1: a purge may be building g<N+1> now, and a reset landing there would serve its half-built chain.
    for (;;) {
      const { at } = await current();
      if (await flip(at, at.n + 2, [at.n, at.n + 1])) return;
    }
  }

  return {
    id: `code.storage:${settings.name}:${agentId}`,
    head: async () => (await current()).ops.head(),
    read: async (ref, paths) => (await current()).ops.read(ref, paths),
    log: async (ref, options) => (await current()).ops.log(ref, options),
    diff: async (commit) => (await current()).ops.diff(commit),
    async save(save) {
      const { at, ops } = await current();
      const done = await ops.save(save, async () => (await generations.get(agentId)).n === at.n);
      return "moved" in done ? { stale: await (await current()).ops.head() } : done;
    },
    rewrite,
    tidy: async () => void (await current(true)),
    remove,
  };
}
