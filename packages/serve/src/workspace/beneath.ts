// Opening a name below a trusted folder through no symbolic link anywhere on the way: how local.ts and grep-worker.ts
// open a file or folder where there is no /proc/self/fd (macOS), so that what is opened is under the root at the open
// itself, whatever the path is swapped to before or after.
//
// On macOS that is the kernel's O_NOFOLLOW_ANY (macOS 11; sys/fcntl.h): the open fails ELOOP at a link anywhere in the
// path, not only at its end. The kernel walks the path folder by folder, each lookup made in the folder before it, so a
// handle it returns was reached from the root through real folders only. node names no such flag; the bit is passed
// as it is, and node 24 runs on no macOS without it. On Linux, where local.ts takes this branch only when a test
// forces it, the same answer comes from a walk from the root: each folder opened with O_NOFOLLOW through
// /proc/self/fd/<fd> of the one before, and a link met on the way is ELOOP, as on macOS. No other platform has a way
// to refuse a link on the way, so there the open fails.
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = constants;
/** macOS's O_NOFOLLOW_ANY (sys/fcntl.h): no link anywhere in the path. */
const O_NOFOLLOW_ANY = 0x20000000;
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
const DARWIN = process.platform === "darwin";
const LINUX = process.platform === "linux";

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const failure = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${message}`), { code });

/** The names of `below` ("" is the root itself, else names joined by "/", none of them "", "." or ".."). */
function namesOf(below: string): string[] {
  const names = below === "" ? [] : below.split("/");
  if (names.some((name) => name === "" || name === "." || name === "..")) throw failure("EINVAL", `${JSON.stringify(below)} is not a path below the root`);
  return names;
}

/** A link on the way as macOS has it: a folder opened with O_DIRECTORY | O_NOFOLLOW that is a link fails ENOTDIR on
 *  Linux, ELOOP with O_NOFOLLOW_ANY. */
const asLoop = (error: unknown, at: string, link: boolean): unknown =>
  errno(error) === "ENOTDIR" && link ? failure("ELOOP", `a symbolic link on the way, open '${at}'`) : error;

/** `root`/`below` opened with `flags` (O_NOFOLLOW added), through no link anywhere below `root` (else ELOOP). */
export async function openBeneath(root: string, below: string, flags: number, mode?: number): Promise<FileHandle> {
  const names = namesOf(below);
  if (DARWIN) return open(names.length === 0 ? root : `${root}/${below}`, flags | O_NOFOLLOW | O_NOFOLLOW_ANY, mode);
  if (!LINUX) throw failure("ENOSYS", `no open on ${process.platform} refuses a symbolic link on the way`);
  if (names.length === 0) return open(root, flags | O_NOFOLLOW, mode);
  const step = async (dir: FileHandle, name: string, how: number, made?: number): Promise<FileHandle> => {
    const at = `/proc/self/fd/${dir.fd}/${name}`;
    try {
      return await open(at, how, made);
    } catch (error) {
      throw asLoop(error, at, await lstat(at).then((stats) => stats.isSymbolicLink(), () => false));
    }
  };
  let dir = await open(root, DIR_FLAGS);
  try {
    for (const name of names.slice(0, -1)) {
      const above = dir;
      dir = await step(dir, name, DIR_FLAGS);
      await above.close();
    }
    return await step(dir, names.at(-1)!, flags | O_NOFOLLOW, mode);
  } finally {
    await dir.close().catch(() => undefined);
  }
}

/** openBeneath, synchronous (grep's worker): the descriptor. */
export function openBeneathSync(root: string, below: string, flags: number, mode?: number): number {
  const names = namesOf(below);
  if (DARWIN) return openSync(names.length === 0 ? root : `${root}/${below}`, flags | O_NOFOLLOW | O_NOFOLLOW_ANY, mode);
  if (!LINUX) throw failure("ENOSYS", `no open on ${process.platform} refuses a symbolic link on the way`);
  if (names.length === 0) return openSync(root, flags | O_NOFOLLOW, mode);
  const step = (dir: number, name: string, how: number, made?: number): number => {
    const at = `/proc/self/fd/${dir}/${name}`;
    try {
      return openSync(at, how, made);
    } catch (error) {
      throw asLoop(error, at, lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() ?? false);
    }
  };
  let dir = openSync(root, DIR_FLAGS);
  try {
    for (const name of names.slice(0, -1)) {
      const above = dir;
      dir = step(dir, name, DIR_FLAGS);
      closeSync(above);
    }
    return step(dir, names.at(-1)!, flags | O_NOFOLLOW, mode);
  } finally {
    closeSync(dir);
  }
}
