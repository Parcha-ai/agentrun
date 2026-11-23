// The local learning store (learn/store.ts): agent `agentId`'s learning folder under the data directory
// (workspace/paths.ts agentLearningFolder), a git repository with main checked out, read and written by learning.sh
// alone, run with the folder as its working directory under an environment named whole. The default store, with no
// setting at all.
//
// The folder is made by the first save, one level at a time from the data directory. A read makes nothing: while a
// level is missing, the store has no head. A level that is a symbolic link (or the folder's .git) is refused as
// FolderUnreadable naming it, so nothing is read, made or run where a link points; the script refuses one inside the
// folder the same way. remove() deletes the folder whole.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentLearningFolder, DISK_DIR } from "../workspace/paths.js";
import { blobOid } from "./folder.js";
import { type ChainCommit, COMMIT, FolderUnreadable, IDENTITY, type LearningStore, MARKER_KEY, type Rewritten, runMarkerText, type Saved, type StoreCommit, type StoreDiffFile, type StoreFile, type StoreSave } from "./store.js";

/** The script, as built beside this file. */
const SCRIPT = fileURLToPath(new URL("./learning.sh", import.meta.url));
/** How long one script run may take: a hung git would hold the folder. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** How long a script's pipes may stay open after it exited and its group was killed, before they are closed here. */
const PIPE_GRACE_MS = 500;
/** The most a script's answer is read: a read of a whole tree is bounded by what a save may write. */
const STDOUT_MAX = 64 << 20;

/** Test seams, tests only: variables added to the script's environment (AGENTRUN_LEARNING_FAIL), each run's argv,
 *  told once the run ended and awaited before its answer is handed back, a shorter deadline than SCRIPT_TIMEOUT_MS, and
 *  each script's process as it starts, before anything reads it (a reader that falls behind). */
export const localStoreHooks: { env?: Record<string, string>; exec?: (argv: readonly string[]) => void | Promise<void>; timeoutMs?: number; spawned?: (child: ChildProcessWithoutNullStreams) => void } = {};

/** The script's environment, whole: it inherits nothing. */
const scriptEnv = (): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  ...localStoreHooks.env,
});

/** One run of the script in `cwd`: its exit code and output. A run past its deadline, or killed, throws. */
async function runScript(cwd: string, args: readonly string[], stdin?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const ran = await spawnScript(cwd, args, stdin);
  await localStoreHooks.exec?.(["sh", SCRIPT, ...args]);
  return ran;
}

/** The script runs as the leader of its own process group, so its deadline, a cut and its exit each kill the group
 *  whole: a git the script started (a gc, a fast-import, a read-tree) never outlives it. Once the script exited, its
 *  pipes get PIPE_GRACE_MS to close before they are closed here, so nothing a stuck git holds open keeps the call. */
function spawnScript(cwd: string, args: readonly string[], stdin?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = localStoreHooks.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    const child = spawn("sh", [SCRIPT, ...args], { cwd, env: scriptEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    localStoreHooks.spawned?.(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let cut = false;
    let timedOut = false;
    let exit: { code: number | null } | undefined;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (): void => {
      if (settled || exit === undefined) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const stderr = Buffer.concat(err).toString("utf8");
      if (cut) return reject(new FolderUnreadable(false, `the learning script's ${args[0]} said more than this server reads`));
      if (timedOut) return reject(new Error(`the learning script's ${args[0]} did not finish in ${timeoutMs / 1000} s: ${stderr.trim().slice(0, 500)}`));
      if (exit.code === null) return reject(new Error(`the learning script's ${args[0]} did not finish: ${stderr.trim().slice(0, 500)}`));
      resolve({ code: exit.code, stdout: Buffer.concat(out), stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_MAX) {
        cut = true;
        killGroup();
      } else if (!cut) out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      reject(error);
    });
    child.on("exit", (code) => {
      exit = { code };
      killGroup();
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, PIPE_GRACE_MS);
    });
    child.on("close", finish);
    child.stdin.end(stdin ?? Buffer.alloc(0));
  });
}

/** The script's failure in words: a link it refused as the folder's, any other as itself. */
function failed(op: string, run: { code: number; stderr: string }): Error {
  const said = run.stderr.trim().replace(/^learning\.sh: /, "");
  if (/a link in the learning folder at /.test(said)) return new FolderUnreadable(true, said);
  return new Error(`the learning script's ${op} failed (exit ${run.code}): ${said.slice(0, 500)}`);
}

/** `dir` checked: a folder, never a symbolic link; made first where absent when `make`. Missing and not made: false. */
async function level(data: string, dir: string, make: boolean): Promise<boolean> {
  const shown = dir.slice(data.length + 1) || "its root";
  if (make) {
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw new FolderUnreadable(false, `the learning folder's ${shown} could not be made: ${error.message}`);
    });
  }
  let stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !make) return false;
    throw new FolderUnreadable(false, `the learning folder's ${shown} could not be read: ${(error as Error).message}`);
  }
  if (stats.isSymbolicLink()) throw new FolderUnreadable(true, `a link in the learning folder at ${shown} can't be followed, so nothing learned is read or written; remove the link`);
  if (!stats.isDirectory()) throw new FolderUnreadable(false, `the learning folder's ${shown} is not a folder`);
  return true;
}

/** The fast-import stream of a save on `old` (none: the first commit), committed on `ref`. */
function importStream(ref: string, save: StoreSave, markers: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const add = (text: string) => parts.push(Buffer.from(text, "utf8"));
  const writes = [...save.writes, ...markers.map((path) => ({ path, text: runMarkerText(save) }))];
  writes.forEach(({ text }, i) => {
    const data = Buffer.from(text, "utf8");
    add(`blob\nmark :${i + 1}\ndata ${data.length}\n`);
    parts.push(data);
    add("\n");
  });
  const who = `${IDENTITY.name} <${IDENTITY.email}> ${save.at} +0000`;
  const body = Buffer.from(save.message, "utf8");
  add(`commit ${ref}\nauthor ${who}\ncommitter ${who}\ndata ${body.length}\n`);
  parts.push(body);
  add(`\n${save.old ? `from ${save.old}\n` : ""}`);
  for (const path of save.deletes ?? []) add(`D ${path}\n`);
  writes.forEach(({ path }, i) => add(`M 100644 :${i + 1} ${path}\n`));
  add("\ndone\n");
  return Buffer.concat(parts);
}

/** The fast-import stream of one commit of a rewrite's chain on `ref`, every file it holds (`deleteall`, then each):
 *  a blob this rewrite wrote already (`written`, by id) named by its id, any other given whole. */
function chainStream(ref: string, one: ChainCommit, written: Set<string>): Buffer {
  const parts: Buffer[] = [];
  const add = (text: string) => parts.push(Buffer.from(text, "utf8"));
  const who = `${IDENTITY.name} <${IDENTITY.email}> ${one.at} +0000`;
  const message = Buffer.from(one.message, "utf8");
  add(`commit ${ref}\nauthor ${who}\ncommitter ${who}\ndata ${message.length}\n`);
  parts.push(message);
  add(`\n${one.parent ? `from ${one.parent}\n` : ""}deleteall\n`);
  for (const file of one.files) {
    const oid = blobOid(file.body);
    if (written.has(oid)) add(`M ${file.mode} ${oid} ${file.path}\n`);
    else {
      add(`M ${file.mode} inline ${file.path}\ndata ${file.body.length}\n`);
      parts.push(file.body);
      add("\n");
      written.add(oid);
    }
  }
  add("\ndone\n");
  return Buffer.concat(parts);
}

/** What the script's `read` printed: its tree (`git ls-tree -r -l -z`) and its blobs (`git cat-file --batch`). */
function parseRead(out: Buffer): StoreFile[] {
  const end = out.indexOf(10);
  const head = /^agentrun-read 2 [0-9a-f]+ (\d+) (\d+)$/.exec(out.subarray(0, end < 0 ? 0 : end).toString("utf8"));
  if (!head) throw new Error("the learning script's read is not one this server reads");
  const treeLen = Number(head[1]);
  const blobLen = Number(head[2]);
  const tree = out.subarray(end + 1, end + 1 + treeLen);
  const raw = out.subarray(end + 1 + treeLen, end + 1 + treeLen + blobLen);
  if (tree.length !== treeLen || raw.length !== blobLen) throw new Error("the learning script's read is cut short");
  const blobs = new Map<string, Buffer>();
  for (let i = 0; i < raw.length;) {
    const nl = raw.indexOf(10, i);
    if (nl < 0) break;
    const [oid = "", type = "", size = ""] = raw.subarray(i, nl).toString("utf8").split(" ");
    if (type === "missing") {
      i = nl + 1;
      continue;
    }
    const length = Number(size);
    blobs.set(oid, Buffer.from(raw.subarray(nl + 1, nl + 1 + length)));
    i = nl + 1 + length + 1;
  }
  const files: StoreFile[] = [];
  for (const entry of tree.toString("utf8").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode = "", type = "", oid = ""] = entry.slice(0, tab).split(/\s+/);
    const body = blobs.get(oid);
    if (type !== "blob" || !body || (mode !== "100644" && mode !== "100755" && mode !== "120000")) continue;
    files.push({ path: entry.slice(tab + 1), mode, body });
  }
  return files;
}

/** What the script's `log` printed: one record a commit, `\x1e<sha>\x1f<parents>\x1f<time>\x1f<message>\x1d`, then
 *  the paths it changed, each ended by NUL. */
function parseLog(out: Buffer): StoreCommit[] {
  return out.toString("utf8").split("\x1e").slice(1).map((record) => {
    const close = record.indexOf("\x1d");
    const [sha = "", parents = "", at = "", ...message] = record.slice(0, close).split("\x1f");
    const files = record.slice(close + 1).split("\0").map((file) => file.replace(/^\n/, "")).filter(Boolean);
    return { sha, parent: parents.split(" ").find(Boolean) ?? null, at, message: message.join("\x1f"), files };
  });
}

const checkCommit = (commit: string): string => {
  if (!COMMIT.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  return commit;
};

/** Agent `agentId`'s local learning store under data directory `data`. */
export function localLearningStore(data: string, agentId: string): LearningStore {
  const root = agentLearningFolder(data, agentId);
  const levels: string[] = [];
  // Every level from <data>/disk down to the folder.
  for (let dir = root; dir !== join(data, DISK_DIR, "..") && dir !== dirname(dir); dir = dirname(dir)) levels.unshift(dir);
  /** Whether the folder is there (each level checked); made first when `make`. */
  const open = async (make: boolean): Promise<boolean> => {
    for (const dir of levels) if (!(await level(data, dir, make))) return false;
    if (!(await level(data, join(root, ".git"), false)) && !make) return false;
    return true;
  };
  /** A read-only op: undefined when the folder is not there or the script exits 1 (no such commit). */
  const reading = async (args: readonly string[]): Promise<Buffer | undefined> => {
    if (!(await open(false))) return undefined;
    const run = await runScript(root, args);
    if (run.code === 1) return undefined;
    if (run.code !== 0) throw failed(args[0]!, run);
    return run.stdout;
  };
  return {
    id: `local:${root}`,
    async head() {
      const out = await reading(["head"]);
      const said = out?.toString("utf8").trim();
      return said ? said : null;
    },
    async read(ref, paths) {
      if (paths && !paths.length) return (await reading(["log", checkCommit(ref), "1"])) ? [] : undefined;
      const out = await reading(["read", checkCommit(ref), ...(paths ?? [])]);
      return out ? parseRead(out) : undefined;
    },
    async log(ref, options = {}) {
      const out = await reading(["log", checkCommit(ref), String(options.limit ?? 0), ...(options.path ? [options.path] : [])]);
      return out ? parseLog(out) : undefined;
    },
    async diff(commit) {
      const out = await reading(["diff", checkCommit(commit)]);
      return out ? (JSON.parse(out.toString("utf8")) as StoreDiffFile[]) : undefined;
    },
    async save(save): Promise<Saved> {
      if (save.run !== undefined && !MARKER_KEY.test(save.run)) throw new Error(`${JSON.stringify(save.run)} is not a marker's key`);
      if (save.old !== null) checkCommit(save.old);
      for (const commit of [...(save.same ?? []).map(({ commit }) => commit), ...(save.seed !== undefined ? [save.seed] : [])]) checkCommit(commit);
      await open(true);
      const ref = `refs/agentrun/import-${randomBytes(8).toString("hex")}`;
      const markers = save.run ? [`.agentrun/runs/${save.run}`] : [];
      const header = [
        `ref ${ref}`,
        ...(save.run ? [`run ${save.run}`] : []),
        ...(save.absent ?? []).map((path) => `absent ${path}`),
        ...(save.same ?? []).map(({ commit, path }) => `same ${commit} ${path}`),
        ...(save.seed !== undefined ? [`seed ${save.seed}`] : []),
      ];
      const stdin = Buffer.concat([Buffer.from(`${header.join("\n")}\n\n`, "utf8"), importStream(ref, save, markers)]);
      const args = save.old === null ? ["init"] : ["commit", save.old];
      const run = await runScript(root, args, stdin);
      const said = run.stdout.toString("utf8").trim();
      if (run.code === 0 && COMMIT.test(said)) return { saved: said };
      // The commit landed and main moved; its working tree, for a person's hand alone, is brought in line by the next.
      if (run.code === 5 && COMMIT.test(said)) return { saved: said };
      if (run.code === 3) return { stale: said || null };
      if (run.code === 4) {
        const lines = said.split("\n");
        const seed = lines.find((line) => line.startsWith("seed "))?.slice(5);
        return { refused: { absent: lines.filter((line) => line.startsWith("absent ")).map((line) => line.slice(7)), same: lines.filter((line) => line.startsWith("same ")).map((line) => line.slice(5)), ...(seed !== undefined ? { seed } : {}) } };
      }
      if (run.code === 6 && COMMIT.test(said)) return { already: said };
      if (run.code === 7) return { unchanged: true };
      throw failed(args[0]!, run);
    },
    async rewrite(old, build): Promise<Rewritten> {
      checkCommit(old);
      if (!(await open(false))) return { stale: null };
      const ref = `refs/agentrun/rewrite-${randomBytes(8).toString("hex")}`;
      const written = new Set<string>();
      let tip: string;
      try {
        tip = checkCommit(await build(async (one) => {
          if (one.parent !== null) checkCommit(one.parent);
          const run = await runScript(root, ["build", ref], chainStream(ref, one, written));
          const said = run.stdout.toString("utf8").trim();
          if (run.code !== 0 || !COMMIT.test(said)) throw failed("build", run);
          return said;
        }));
      } catch (error) {
        await runScript(root, ["drop", ref]).catch(() => undefined);
        throw error;
      }
      const run = await runScript(root, ["rewrite", old, tip, ref]);
      const said = run.stdout.toString("utf8").trim();
      if (run.code === 0 && said === tip) return { saved: tip };
      if (run.code === 3) return { stale: said || null };
      throw failed("rewrite", run);
    },
    async tidy() {
      if (!(await open(false))) return;
      const run = await runScript(root, ["tidy"]);
      if (run.code !== 0) throw failed("tidy", run);
    },
    // An erasure is a reset here: the folder, every commit of it, is all the store keeps.
    async remove() {
      // Each level on the way checked first: a link there is never followed, the folder behind it never removed.
      for (const dir of levels.slice(0, -1)) if (!(await level(data, dir, false))) return;
      await rm(root, { recursive: true, force: true });
    },
  };
}
