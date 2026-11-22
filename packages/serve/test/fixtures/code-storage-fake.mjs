// An in-memory code.storage, at its HTTP API, as the learning store's adapter (src/learn/code-storage.ts) calls it: a
// `fetch` the adapter is given in place of the network. It follows what the spike against the real API observed:
// - the repo is taken from the bearer JWT's `repo` claim, never from the request; the JWT is signed with the org's key
//   by its kind (EC ES256, RSA RS256, Ed25519 EdDSA), and its `iss` is the org (a token for another org, or a bad
//   signature, is 401); `calls` records the repo id of every request, so a test can check none left agentrun-;
// - a commit (POST /repos/commit-pack, ndjson: one metadata line, then base64 blob chunks) moves `target_branch` only
//   from `expected_target_sha` (40 zeros for a branch not made yet; `expected_head_sha`, its deprecated name, alike): a
//   stale head is 409 with result.status "conflict" and writes nothing; a metadata field the API does not name is 400
//   (its schema takes no other); with neither, the branch moves unconditionally, as the API's does; a tree the same as
//   the head's is refused with result.status "precondition_failed", "no changes to commit";
// - a repo deleted is 404 to every read, and the same id made again starts empty (no main: /repos/files 404).
// Commit ids are sha1 hex of their own fields, not git's: a store reads them back, never recomputes them.
import { createHash, createPublicKey, KeyObject, verify } from "node:crypto";

const ZERO = "0".repeat(40);
/** The fields commit-pack's metadata takes (its schema's additionalProperties is false). */
const METADATA = new Set(["target_branch", "commit_message", "author", "committer", "files", "base_branch", "base_is_ephemeral", "target_is_ephemeral", "ephemeral", "ephemeral_base", "expected_head_sha", "expected_target_sha"]);

/** A fake code.storage org `name`, its key's public half `publicKey` (PEM or KeyObject). `fetch` is what the adapter
 *  is handed; `calls` every request it made ({ method, path, repo }); `repos` the store, by id. */
export function codeStorageFake({ name = "example-org", publicKey } = {}) {
  const key = publicKey === undefined ? undefined : publicKey instanceof KeyObject ? publicKey : createPublicKey(publicKey);
  /** id -> { commits: Map<sha, commit>, main: sha | null } */
  const repos = new Map();
  const calls = [];
  let counter = 0;

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (status, error) => json(status, { error });

  /** The JWT's claims, checked: its signature, its org; else undefined. */
  function claims(header) {
    const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    if (!token) return undefined;
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return undefined;
    try {
      const head = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      // Its alg is its key's kind (EC ES256, RSA RS256, Ed25519 EdDSA), as code.storage's SDK signs.
      const algs = { ec: "ES256", rsa: "RS256", ed25519: "EdDSA" };
      if (!Object.values(algs).includes(head.alg) || (key && algs[key.asymmetricKeyType] !== head.alg)) return undefined;
      const data = Buffer.from(`${h}.${p}`);
      const signature = Buffer.from(s, "base64url");
      if (key && !(head.alg === "EdDSA" ? verify(null, data, key, signature) : head.alg === "RS256" ? verify("sha256", data, key, signature) : verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature))) return undefined;
      const body = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      if (body.iss !== name || typeof body.repo !== "string" || !Array.isArray(body.scopes)) return undefined;
      if (typeof body.exp !== "number" || body.exp * 1000 < Date.now()) return undefined;
      return body;
    } catch {
      return undefined;
    }
  }

  const treeOf = (repo, sha) => (sha ? repo.commits.get(sha).tree : new Map());
  const sameTree = (a, b) => a.size === b.size && [...a].every(([path, bytes]) => b.has(path) && Buffer.compare(b.get(path), bytes) === 0);
  /** The first-parent history of `from`, newest first. */
  function history(repo, from) {
    const out = [];
    for (let sha = from; sha; sha = repo.commits.get(sha).parent) out.push(repo.commits.get(sha));
    return out;
  }
  const changedPaths = (repo, commit) => {
    const before = treeOf(repo, commit.parent);
    const after = commit.tree;
    return [...new Set([...before.keys(), ...after.keys()])].filter((path) => !before.has(path) || !after.has(path) || Buffer.compare(before.get(path), after.get(path)) !== 0).sort();
  };
  const lines = (bytes) => (bytes ? bytes.toString("utf8").replace(/\n$/, "").split("\n") : []);
  /** The hunks of a unified diff of `old` to `now` (lines), three lines of context, as git writes them. */
  function hunks(old, now) {
    // The longest common subsequence, then the edit script from it: [" ", line] kept, ["-", line], ["+", line].
    const n = old.length;
    const m = now.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = old[i] === now[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && old[i] === now[j]) ops.push([" ", old[i++], j++]);
      else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push(["+", now[j++]]);
      else ops.push(["-", old[i++]]);
    }
    const out = [];
    const changed = ops.map((op, k) => (op[0] !== " " ? k : -1)).filter((k) => k >= 0);
    let k = 0;
    while (k < changed.length) {
      let start = Math.max(0, changed[k] - 3);
      let end = Math.min(ops.length, changed[k] + 4);
      while (k + 1 < changed.length && changed[k + 1] - 3 <= end) end = Math.min(ops.length, changed[++k] + 4);
      k += 1;
      let oldAt = 0;
      let nowAt = 0;
      for (const op of ops.slice(0, start)) {
        if (op[0] !== "+") oldAt += 1;
        if (op[0] !== "-") nowAt += 1;
      }
      const body = ops.slice(start, end);
      const oldCount = body.filter((op) => op[0] !== "+").length;
      const nowCount = body.filter((op) => op[0] !== "-").length;
      const range = (at, count) => `${count ? at + 1 : at}${count === 1 ? "" : `,${count}`}`;
      out.push(`@@ -${range(oldAt, oldCount)} +${range(nowAt, nowCount)} @@\n${body.map((op) => `${op[0]}${op[1]}\n`).join("")}`);
    }
    return out.join("");
  }
  function rawDiff(path, before, after) {
    return `diff --git a/${path} b/${path}\n--- ${before ? `a/${path}` : "/dev/null"}\n+++ ${after ? `b/${path}` : "/dev/null"}\n${hunks(lines(before), lines(after))}`;
  }
  const commitView = (commit) => ({ sha: commit.sha, parent_shas: commit.parent ? [commit.parent] : [], message: commit.message, author_name: commit.author.name, author_email: commit.author.email, committer_name: commit.author.name, committer_email: commit.author.email, date: commit.date });

  async function commitPack(repo, body) {
    const text = Buffer.from(await body).toString("utf8");
    const [first, ...rest] = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const meta = first?.metadata;
    if (!meta || meta.target_branch !== "main") return fail(400, "commit-pack takes a metadata line naming main");
    const blobs = new Map();
    for (const line of rest) {
      const chunk = line.blob_chunk;
      blobs.set(chunk.content_id, Buffer.concat([blobs.get(chunk.content_id) ?? Buffer.alloc(0), Buffer.from(chunk.data, "base64")]));
    }
    const old = repo.main;
    const result = (status, message, success = false, extra = {}) => ({ branch: "main", old_sha: old ?? ZERO, new_sha: extra.new_sha ?? ZERO, success, status, ...(message ? { message } : {}) });
    const unknown = Object.keys(meta).filter((key) => !METADATA.has(key));
    if (unknown.length) return fail(400, `commit-pack's metadata takes no ${unknown.join(", ")}`);
    const expected = meta.expected_target_sha ?? meta.expected_head_sha;
    if (expected !== undefined && expected !== (old ?? ZERO)) return json(409, { commit: null, result: result("conflict", "expected head does not match") });
    const tree = new Map(treeOf(repo, old));
    for (const file of meta.files) {
      if (file.operation === "delete") tree.delete(file.path);
      else tree.set(file.path, blobs.get(file.content_id) ?? Buffer.alloc(0));
    }
    if (old && sameTree(tree, treeOf(repo, old))) return json(422, { commit: null, result: result("precondition_failed", "no changes to commit") });
    const sha = createHash("sha1").update(`${++counter}\0${old}\0${meta.commit_message}`).digest("hex");
    repo.commits.set(sha, { sha, parent: old, tree, message: meta.commit_message, author: meta.author, date: new Date().toISOString() });
    repo.main = sha;
    return json(200, { commit: { commit_sha: sha, tree_sha: sha, target_branch: "main", pack_bytes: text.length, blob_count: blobs.size }, result: result("ok", undefined, true, { new_sha: sha }) });
  }

  async function fetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const prefix = "/api/v1/";
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const claim = claims(new Headers(init.headers).get("authorization"));
    calls.push({ method, path, repo: claim?.repo, search: url.search });
    if (!claim) return fail(401, "unauthorized");
    const can = (scope) => claim.scopes.includes(scope);
    const id = claim.repo;
    const repo = repos.get(id);
    const q = url.searchParams;
    if (method === "POST" && path === "repos") {
      if (!can("repo:write")) return fail(403, "insufficient permissions");
      if (repo) return fail(409, "repository already exists");
      repos.set(id, { commits: new Map(), main: null });
      return json(201, { repo_id: id, url: `${id}.git` });
    }
    if (method === "DELETE" && path === "repos/delete") {
      if (!can("repo:write")) return fail(403, "insufficient permissions");
      if (!repo) return fail(404, "repository not found");
      repos.delete(id);
      return json(200, { repo_id: id, message: "deleted" });
    }
    if (method === "POST" && path === "repos/commit-pack") {
      if (!can("git:write")) return json(403, { commit: null, result: { status: "forbidden", message: "insufficient permissions" } });
      if (!repo) return fail(404, "repository not found");
      return commitPack(repo, new Response(init.body).arrayBuffer());
    }
    if (method !== "GET") return fail(405, "method not allowed");
    if (!can("git:read")) return fail(403, "insufficient permissions");
    if (!repo) return fail(404, "repository not found");
    const at = (ref) => (ref === "main" || !ref ? repo.main : repo.commits.has(ref) ? ref : undefined);
    if (path === "repos/files") {
      const sha = at(q.get("ref"));
      if (!sha) return fail(404, "ref not found");
      const entries = [...treeOf(repo, sha).keys()].sort().map((one) => ({ path: one, type: "blob", mode: "100644" }));
      return json(200, { paths: entries.map((entry) => entry.path), ref: sha, entries, next_cursor: null, has_more: false });
    }
    if (path === "repos/file") {
      const sha = at(q.get("ref"));
      const bytes = sha ? treeOf(repo, sha).get(q.get("path")) : undefined;
      if (!bytes) return fail(404, "file not found");
      return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    if (path === "repos/commits") {
      if ((q.get("branch") ?? "main") !== "main") return fail(404, "branch not found");
      if (!repo.main) return fail(404, "branch not found");
      let all = history(repo, repo.main);
      const only = q.get("path");
      if (only) all = all.filter((commit) => changedPaths(repo, commit).includes(only));
      const from = Number(q.get("cursor") ?? 0);
      const limit = Number(q.get("limit") ?? 20);
      const page = all.slice(from, from + limit);
      const more = from + limit < all.length;
      return json(200, { commits: page.map(commitView), next_cursor: more ? String(from + limit) : null, has_more: more });
    }
    if (path === "repos/commit") {
      const commit = repo.commits.get(q.get("sha") ?? "");
      if (!commit) return fail(404, "commit not found");
      return json(200, { commit: commitView(commit) });
    }
    if (path === "repos/diff") {
      const commit = repo.commits.get(q.get("sha") ?? "");
      if (!commit) return fail(404, "commit not found");
      const before = treeOf(repo, commit.parent);
      const files = changedPaths(repo, commit).map((one) => {
        const raw = rawDiff(one, before.get(one), commit.tree.get(one));
        return { path: one, state: !before.has(one) ? "added" : !commit.tree.has(one) ? "deleted" : "modified", old_path: null, raw, bytes: raw.length, is_eof: true };
      });
      return json(200, { sha: commit.sha, base_sha: commit.parent ?? undefined, stats: { files: files.length, additions: 0, deletions: 0, changes: 0 }, files, filtered_files: [] });
    }
    return fail(404, `no route ${path}`);
  }

  return { fetch, calls, repos, name };
}
