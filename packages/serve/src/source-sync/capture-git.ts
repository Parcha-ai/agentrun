// Git reads only a bounded, server-private copy. The managed project's config, hooks, filters and path
// indirections are never given to Git, even if a task changes them between metadata reads.
import { createHash } from "node:crypto";
import { secretsIn } from "../secret-cut.js";
import { secretShapes } from "../learn/secrets.js";
import { relativeSegments } from "../workspace/paths.js";
import type { Workspace } from "../workspace/workspace.js";
import type { ProjectGitCapture, ProjectGitOptions, ProjectInventorySelector } from "./capture-project.js";
import { SnapshotError } from "./snapshots.js";
import { ProjectCaptureRefusal, recheckCapture } from "./capture-refusal.js";

const ENV = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
const GIT = ["git", "--git-dir=database", "--work-tree=work", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.quotePath=false", "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
const digest = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");
function refuse(message = "Git metadata needs an explicit safe, complete project representation."): never { throw new ProjectCaptureRefusal("prerequisite", message); }
function pathOf(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 4096 || value.split("/").includes(".git")) refuse();
  try { relativeSegments(value); } catch { refuse(); }
  return value;
}
function text(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refuse("Git paths must be portable UTF-8."); }
}
const credentialPath = (path: string): boolean => path.split("/").some(part => /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|\.credentials\.json|\.claude\.json|id_(?:rsa|ed25519)|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.gnupg)$/i.test(part)) || /\.(?:pem|p12|pfx|key)$/i.test(path);
type Row = { path: string; kind: string; bytes: number; mode: number };
async function execute(work: Workspace, argv: readonly string[], options: ProjectGitOptions, max: number, stdin?: Uint8Array, noMatches = false): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const result = await work.exec([...argv], { env: ENV, timeoutMs: 30_000, maxOutput: max, ...(stdin ? { stdin } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  options.signal?.throwIfAborted();
  if (result.code !== 0 && !(noMatches && result.code === 1) || result.signal || result.timedOut || result.truncated)
    throw new SnapshotError("prerequisite", "Git capture could not finish within its safe bounds.");
  return Buffer.from(result.stdout);
}
async function databaseInventory(work: Workspace, options: ProjectGitOptions): Promise<Row[]> {
  const result = await execute(work, ["find", ".git", "(", "-path", ".git/hooks", "-o", "-path", ".git/logs", ")", "-prune", "-o", "-printf", String.raw`%y\0%m\0%s\0%p\0`], options, options.limits.manifestBytes);
  const fields = text(result).split("\0"), rows: Row[] = [];
  if (fields.pop() !== "" || fields.length % 4) refuse();
  for (let n = 0; n < fields.length; n += 4) {
    const [kind, mode, bytes, raw] = fields.slice(n, n + 4) as [string, string, string, string];
    if (raw === ".git") { if (kind !== "d") refuse(); continue; }
    if (!raw.startsWith(".git/")) refuse();
    const path = pathOf(raw.slice(5));
    if (!["d", "f"].includes(kind) || !/^[0-7]{1,3}$/.test(mode) || !/^\d+$/.test(bytes) || !Number.isSafeInteger(Number(bytes))) refuse();
    rows.push({ path, kind, bytes: kind === "d" ? 0 : Number(bytes), mode: parseInt(mode, 8) });
    if (rows.length > options.limits.files) throw new ProjectCaptureRefusal("limit", "The Git database exceeds its file limit.");
  }
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const copied = (path: string): boolean => ["HEAD", "index", "packed-refs", "info/exclude"].includes(path) || path === "objects" || path.startsWith("objects/") || path === "refs" || path.startsWith("refs/");
const forbidden = (path: string): boolean => ["commondir", "gitdir", "shallow", "objects/info/alternates", "objects/info/http-alternates"].includes(path) || /^(?:worktrees|modules)(?:\/|$)/.test(path);

/** scratch must be a fresh private folder outside the model's tool root, on the same explicitly pinned backend.
 * Its caller owns cleanup and holds the executor's strict drain until this promise settles. */
export async function captureGit(work: Workspace, scratch: Workspace, options: ProjectGitOptions): Promise<ProjectGitCapture> {
  options = { ...options, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]) };
  if ((await scratch.list("")).length) refuse("Git checkpoint scratch must be a fresh private folder.");
  const before = await databaseInventory(work, options), held = new Map<string, string>(), working = new Map<string, { bytes: number; sha: string }>(); let copiedBytes = 0;
  if (before.some(row => forbidden(row.path) && (row.kind === "d" || row.bytes > 0))) refuse();
  const read = async (row: Row): Promise<Buffer> => {
    if (row.bytes > options.limits.gitBytes) throw new ProjectCaptureRefusal("limit", "Git control bytes exceed the checkpoint limit.");
    const bytes = Buffer.from(await work.read(`.git/${row.path}`, { length: row.bytes + 1 })); options.signal?.throwIfAborted();
    if (bytes.length !== row.bytes) throw new SnapshotError("conflict", "Git bytes changed during checkpoint capture.");
    held.set(row.path, digest(bytes)); return bytes;
  };
  for (const row of before.filter(row => /^config(?:\.worktree)?$/.test(row.path))) {
    if (row.kind !== "f") refuse(); const config = text(await read(row));
    if (/^\s*\[\s*(?:include|includeIf|filter|extensions|submodule)(?:\s|\]|\")/mi.test(config)
      || /^\s*(?:worktree\s*=|bare\s*=\s*true|excludesfile\s*=|sparsecheckout\s*=)/mi.test(config)) refuse("Git includes, filters, sparse indexes and external stores need an explicit safe representation.");
  }
  await scratch.mkdir("database"); await scratch.mkdir("work");
  for (const row of before.filter(row => copied(row.path))) {
    options.signal?.throwIfAborted();
    if (row.kind === "d") await scratch.mkdir(`database/${row.path}`);
    else {
      copiedBytes += row.bytes; if (copiedBytes > options.limits.gitBytes) throw new ProjectCaptureRefusal("limit", "The private Git database exceeds the checkpoint limit.");
      await scratch.write(`database/${row.path}`, await read(row));
    }
  }
  await scratch.write("database/config", "[core]\n repositoryformatversion = 0\n bare = false\n filemode = true\n");
  const git = (args: readonly string[], maximum = options.limits.manifestBytes): Promise<Buffer> => execute(scratch, [...GIT, ...args], options, maximum);
  const head = text(await git(["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) refuse("This Git object format needs a supported complete export.");
  const headBytes = await scratch.read("database/HEAD", { length: 4097 }), headText = text(headBytes).trim();
  let branch: string | null = null;
  if (headText.startsWith("ref: ")) {
    const ref = headText.slice(5); if (!ref.startsWith("refs/heads/")) refuse();
    await git(["check-ref-format", ref]); branch = ref.slice(11);
  } else if (headText !== head) refuse();
  const tree = text(await git(["rev-parse", "--verify", `${head}^{tree}`])).trim();
  if (text(await git(["write-tree"])).trim() !== tree) refuse("Commit or unstage index changes before checkpointing this project.");
  const index = new Map<string, { mode: string; oid: string }>();
  for (const row of text(await git(["ls-files", "--stage", "-z"])).split("\0").filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(row); if (!match) refuse();
    index.set(pathOf(match[3]!), { mode: match[1]!, oid: match[2]! });
  }
  // Evaluate each directory's rules in the isolated database before descending. Neither the ignored tree's
  // contents nor its links/nested repositories consume the durable project's limits. Tracked descendants and
  // authored skills remain selected even under an ignored parent.
  const trackedParents = new Set<string>();
  for (const path of index.keys()) {
    const parts = path.split("/");
    for (let n = 1; n <= parts.length; n++) trackedParents.add(parts.slice(0, n).join("/"));
  }
  const select: ProjectInventorySelector = async rows => {
    // Each traversal evaluates the current names/rules afresh. Otherwise a deleted ignore file or a directory
    // replaced by a regular file could retain its old ignored status in this private verification view.
    if (rows.some(row => row.path === "")) { await scratch.remove("work", { recursive: true }); await scratch.mkdir("work"); }
    // Git must know which candidates are directories, but a trailing slash would apply that directory's own
    // rules to an empty child on the verification pass. Empty placeholders preserve Git's normal path semantics.
    for (const row of rows) if (row.path && row.path !== ".git" && row.type === "directory") await scratch.mkdir(`work/${row.path}`);
    for (const row of rows.filter(row => row.path.split("/").at(-1) === ".gitignore")) {
      if (row.type !== "file" || row.bytes > options.limits.fileBytes) refuse("Git ignore rules need a bounded regular file.");
      const bytes = await work.read(row.path, { length: row.bytes + 1 }), sha = digest(bytes), previous = working.get(row.path);
      if (bytes.length !== row.bytes || previous && (previous.bytes !== row.bytes || previous.sha !== sha)) throw new SnapshotError("conflict", "Git ignore rules changed during checkpoint capture.");
      working.set(row.path, { bytes: row.bytes, sha });
      await scratch.write(`work/${row.path}`, bytes);
    }
    const names = rows.filter(row => row.path && row.path !== ".git").map(row => row.path);
    const ignored = new Set<string>();
    if (names.length) {
      const output = text(await execute(scratch, [...GIT, "check-ignore", "--no-index", "--stdin", "-z"], options, options.limits.manifestBytes, Buffer.from(`${names.join("\0")}\0`), true));
      const found = output.split("\0");
      if (found.pop() !== "") refuse("Git returned incomplete ignore selection.");
      const requested = new Set(names);
      for (const name of found) { if (!requested.has(name)) refuse(); ignored.add(name); }
    }
    return new Set(rows.filter(row => row.path === "" || row.path === ".git" || !ignored.has(row.path) || trackedParents.has(row.path)
      || options.retain.some(path => row.path === path || row.path.startsWith(`${path}/`) || path.startsWith(`${row.path}/`))).map(row => row.path));
  };
  const inventory = await options.inventory(select);
  // Only selected placeholders and ignore rules enter the private work tree; no project program is executed.
  for (const row of inventory) {
    if (!row.path || row.path === ".git") continue;
    if (row.type === "directory") await scratch.mkdir(`work/${row.path}`);
    else if (row.path.split("/").at(-1) !== ".gitignore") await scratch.write(`work/${row.path}`, new Uint8Array());
  }
  const files = [...new Set([...index.keys(), ...text(await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).map(pathOf)])].sort();
  const unsafePath = (path: string): boolean => credentialPath(path) || options.secretValues?.some(value => value && path.includes(value)) === true
    || options.exclude.some(item => path === item.path || item.recursive && path.startsWith(`${item.path}/`));
  const safeBytes = async (body: Uint8Array): Promise<void> => {
    const value = Buffer.from(body).toString("utf8");
    if (options.secretValues?.some(secret => secret && (value.includes(secret) || value.includes(JSON.stringify(secret).slice(1, -1)))) || secretShapes(value).length || (await secretsIn(value)).length) refuse("Credential-bearing Git history was withheld from the checkpoint.");
  };
  // A branch name is output metadata; `bundle ... HEAD` need not contain it in any scanned history object.
  if (branch !== null) await safeBytes(Buffer.from(branch));
  const deleted: string[] = []; let dirty = false;
  for (const path of files) {
    if (unsafePath(path)) refuse("Git history or tracked paths contain credentials or host-owned runtime input.");
    const row = inventory.find(row => row.path === path), tracked = index.get(path);
    if (!row) { if (tracked) { deleted.push(path); dirty = true; } continue; }
    if (row.type !== "file" || row.bytes > options.limits.fileBytes) refuse();
    const body = Buffer.from(await work.read(path, { length: row.bytes + 1 })); options.signal?.throwIfAborted();
    if (body.length !== row.bytes) throw new SnapshotError("conflict", "Project bytes changed during Git capture.");
    working.set(path, { bytes: row.bytes, sha: digest(body) });
    const oid = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
    if (!tracked || tracked.oid !== oid || (tracked.mode === "100755") !== !!(row.mode & 0o111)) dirty = true;
  }
  const objects = text(await git(["rev-list", "--objects", head])).split("\n").filter(Boolean);
  if (objects.length > options.limits.files) throw new ProjectCaptureRefusal("limit", "Git history exceeds its object limit.");
  let historyBytes = 0;
  for (const line of objects) {
    const match = /^([a-f0-9]{40})(?: (.*))?$/.exec(line); if (!match || match[2] && unsafePath(pathOf(match[2]))) refuse();
    const oid = match[1]!, kind = text(await git(["cat-file", "-t", oid])).trim();
    const body = await git(["cat-file", "-p", oid], options.limits.fileBytes); historyBytes += body.length;
    if (historyBytes > options.limits.gitBytes) throw new ProjectCaptureRefusal("limit", "Expanded Git history exceeds its checkpoint limit.");
    await safeBytes(body);
    if (kind === "commit") {
      // Every historical alias is checked: rev-list names shared blobs only once, which is insufficient when the
      // same object also appears under a credential or runtime-input path in another commit.
      for (const entry of text(await git(["ls-tree", "-r", "-z", oid])).split("\0").filter(Boolean)) {
        const found = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry); if (!found || unsafePath(pathOf(found[2]!))) refuse("Git history contains unsupported or excluded paths.");
      }
    } else if (!["tree", "blob"].includes(kind)) refuse();
  }
  const bundle = await git(["bundle", "create", "-", "HEAD"], options.limits.gitBytes);
  const verify = (): Promise<void> => recheckCapture(async () => {
    if (JSON.stringify(inventory) !== JSON.stringify(await options.inventory(select))) throw new SnapshotError("conflict", "Project metadata changed during checkpoint capture.");
    if (JSON.stringify(before) !== JSON.stringify(await databaseInventory(work, options))) throw new SnapshotError("conflict", "Git metadata changed during checkpoint capture.");
    for (const row of before.filter(row => held.has(row.path))) {
      const bytes = await work.read(`.git/${row.path}`, { length: row.bytes + 1 }); options.signal?.throwIfAborted();
      if (bytes.length !== row.bytes || digest(bytes) !== held.get(row.path)) throw new SnapshotError("conflict", "Git bytes changed during checkpoint capture.");
    }
    for (const [path, was] of working) {
      const bytes = await work.read(path, { length: was.bytes + 1 }); options.signal?.throwIfAborted();
      if (bytes.length !== was.bytes || digest(bytes) !== was.sha) throw new SnapshotError("conflict", "Project bytes changed after Git capture.");
    }
  });
  await verify();
  return { files, inventory, bundle, verify, metadata: { head, branch, dirty, deleted, history: "complete" } };
}
