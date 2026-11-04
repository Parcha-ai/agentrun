// Learning, after a run: what its end-of-run turn added to the run's copy of its agent's folder is read by the host,
// checked against the commit the run started from (learn/check.ts checkProposal), and kept in the run's own directory
// as its proposal (`learning-proposal.json`), or dropped. The copy is read from its snapshot, `<run dir>/learning-turn/`,
// where it was moved from `work/.learning/` as the run settled (learning.ts snapshotLearned): never from the run's work,
// which a follow-up may change. The host reads it itself, in the agent's queue: the folder's top only, each entry looked
// at without following a link, never more of one file than the note cap, and never past the cap on changed paths.
// Nothing is written to git here, and nothing is written at all before the checks pass: a note they refuse (one
// holding a secret among them) is never kept anywhere.
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { CAPS, type Change, checkProposal, INDEX_FILE, type Problem, printable } from "./learn/index.js";
import { homeOf, writeDurable } from "./files.js";
import { activeOf, agentFolder, LEARNED_SNAPSHOT, type Proposal, PROPOSAL, readSeed, withAgentRepo } from "./learning.js";

export type Proposed = { state: "proposed"; notes: number } | { state: "dropped"; reason: "empty" } | { state: "dropped"; reason: "checker"; problems: Problem[] };

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** A name that is not UTF-8, as a problem shows it: printable ASCII as it is, every other byte `\xNN`. */
const escaped = (name: Buffer) => [...name].map((byte) => (byte >= 0x20 && byte < 0x7f && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`)).join("");
/** Git's mode for an entry that is not a regular file: a link, a folder, anything else. */
const modeOf = (info: { isSymbolicLink(): boolean; isDirectory(): boolean }) => (info.isSymbolicLink() ? "120000" : info.isDirectory() ? "040000" : "000000");

/** The file at `full`, opened without following a link: its bytes, its size when it is over the note cap, or undefined
 *  when it is not a regular file by then (a link put in its place since it was looked at). */
async function readRegular(full: string): Promise<{ bytes: Buffer } | { size: number } | undefined> {
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > CAPS.note) return { size: info.size };
    const buffer = Buffer.alloc(CAPS.note + 1);
    let length = 0;
    for (let got = 1; got > 0 && length <= CAPS.note; length += got) got = (await handle.read(buffer, length, CAPS.note + 1 - length, length)).bytesRead;
    return length > CAPS.note ? { size: length } : { bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

/** What the run's copy `dir` changed against `laid`, the notes it was given by file. `MEMORY.md` is never read. Each
 *  entry is looked at with lstat, and a link, a folder or anything else that is not a regular file is a change of its
 *  own mode, never followed or read. A name that is not UTF-8 is a problem of its own and is never read. The walk stops
 *  past the cap on changed paths. */
async function harvest(dir: string, laid: ReadonlyMap<string, string>): Promise<{ changes: Change[]; own: Problem[] }> {
  const changes: Change[] = [];
  const own: Problem[] = [];
  const found = new Set<string>();
  // The copy itself is never followed either: one that is a link, or not a folder, is refused. One that is not there at
  // all was never set aside, which is a fault, not what the run proposed.
  const root = await lstat(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? Promise.reject(error) : error));
  if (root instanceof Error || !root.isDirectory()) return { changes, own: [{ rule: "file_mode", detail: "the run's copy of the folder is not a folder: never followed" }] };
  let looks = laid.size + CAPS.changes + 1;
  // Names as their bytes: one that is not UTF-8 is seen as it is, never read as another name. (Node takes "buffer"
  // here; its types list only the text encodings.)
  for await (const entry of await opendir(dir, { encoding: "buffer" as BufferEncoding })) {
    if (--looks < 0) return { changes: [], own: [{ rule: "too_many_files", detail: `more than ${CAPS.changes} changed paths; the cap is ${CAPS.changes} a run, and nothing else was read` }] };
    const raw = entry.name as unknown as Buffer;
    let name: string;
    try {
      name = utf8.decode(raw);
    } catch {
      own.push({ rule: "encoding", path: escaped(raw), detail: "its name is not UTF-8: never read" });
      continue;
    }
    found.add(name);
    if (name === INDEX_FILE) continue;
    const status = laid.has(name) ? "modified" : "added";
    const info = await lstat(join(dir, name)).catch(() => undefined);
    if (!info) {
      own.push({ rule: "file_mode", path: name, detail: "it could not be looked at: never read" });
      continue;
    }
    const file = info.isFile() ? await readRegular(join(dir, name)) : undefined;
    if (!file) changes.push({ path: name, status, mode: info.isFile() ? "000000" : modeOf(info) });
    else if ("size" in file) changes.push({ path: name, status, mode: "100644", size: file.size });
    else if (status === "added" || !file.bytes.equals(Buffer.from(laid.get(name)!))) changes.push({ path: name, status, mode: "100644", bytes: file.bytes });
  }
  for (const name of laid.keys()) if (!found.has(name)) changes.push({ path: name, status: "deleted" });
  return { changes, own };
}

/** What run `runId`'s end-of-run turn added, read from its snapshot, checked against its seed `seed` (its pin) and kept
 *  in `runDir` as its proposal; or `empty` when it added nothing, or `checker` with the problems, printable. `refuse`:
 *  this host's secrets. In the agent's queue. A snapshot that is not there throws. */
export const proposeRun = (input: { data: string; agentId: string; runDir: string; seed: string; refuse: readonly string[] }): Promise<Proposed> => withAgentRepo(input.data, input.agentId, async () => {
  const seed = await readSeed(homeOf(input.data, input.agentId), await agentFolder(input.data, input.agentId), input.seed);
  const { changes, own } = await harvest(join(input.runDir, LEARNED_SNAPSHOT), new Map(Object.entries(seed.notes))).catch((error: NodeJS.ErrnoException) => {
    // Never the error's own text, which names a path of the run's: it may hold anything.
    throw new Error(`the run's copy of the folder could not be read (${error.code ?? "error"})`);
  });
  const checked = checkProposal({ base: { files: seed.files, active: activeOf(seed) }, changes, refuseValues: input.refuse });
  const problems = [...own.map((problem) => printable(problem, input.refuse)), ...checked.problems];
  if (problems.length) return { state: "dropped", reason: "checker", problems };
  if (!checked.notes.length) return { state: "dropped", reason: "empty" };
  const proposal: Proposal = { seed: input.seed, notes: checked.notes.map(({ file, text }) => ({ file, text })) };
  await writeDurable(join(input.runDir, PROPOSAL), `${JSON.stringify(proposal)}\n`);
  return { state: "proposed", notes: proposal.notes.length };
});
