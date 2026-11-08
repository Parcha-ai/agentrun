// LocalWorkspace's grep, in a worker thread: the caller's regex runs here, so one that backtracks without end blocks
// this thread, never the runner's, and local.ts terminates it at the deadline. It searches the folder `dir` names (on
// Linux, /proc/self/fd/<fd> of a folder local.ts holds open for it), or the one file `only` in it, opening every entry
// with O_NOFOLLOW: a link is skipped, never followed. Matches are posted a file at a time; the last message is
// `{ done: false | "max" }`.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

export type GrepJob = {
  readonly dir: string;
  readonly rel: string;
  readonly only?: string;
  readonly pattern: string;
  readonly glob?: string;
  readonly limit: number;
  readonly fileMax: number;
  readonly lineMax: number;
  readonly probe: number;
};
type Match = { path: string; line: number; text: string };

const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;
const LINUX = process.platform === "linux";

/** A glob (`*`, `**`, `?`) as a regex over a relative path. */
export function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const sorted = (names: string[]): string[] => names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function run(job: GrepJob, post: (message: unknown) => void): void {
  const regex = new RegExp(job.pattern);
  const glob = job.glob === undefined ? undefined : { regex: globRegex(job.glob), whole: job.glob.includes("/") };
  let found = 0;
  const STOP = Symbol("stop");

  const searchFile = (fd: number, size: number, rel: string, name: string): void => {
    if (size > job.fileMax || (glob && !glob.regex.test(glob.whole ? rel : name))) return;
    const content = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const got = readSync(fd, content, filled, size - filled, filled);
      if (got === 0) break;
      filled += got;
    }
    const bytes = content.subarray(0, filled);
    if (bytes.subarray(0, job.probe).includes(0)) return;
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const matches: Match[] = [];
    try {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.endsWith("\r") ? lines[i]!.slice(0, -1) : lines[i]!;
        if (!regex.test(line)) continue;
        if (found === job.limit) throw STOP;
        found++;
        matches.push({ path: rel, line: i + 1, text: line.length > job.lineMax ? line.slice(0, job.lineMax) : line });
      }
    } finally {
      if (matches.length > 0) post({ matches });
    }
  };
  /** Entry `name` of folder `dir`, opened without following a link, searched if it is a file or a folder. */
  const searchEntry = (dir: string, name: string, rel: string): void => {
    let fd: number;
    try {
      fd = openSync(`${dir}/${name}`, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
      return;
    }
    try {
      const stats = fstatSync(fd);
      if (stats.isDirectory()) searchDir(LINUX ? `/proc/self/fd/${fd}` : `${dir}/${name}`, rel);
      else if (stats.isFile()) searchFile(fd, stats.size, rel, name);
    } finally {
      closeSync(fd);
    }
  };
  const searchDir = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = sorted(readdirSync(dir));
    } catch {
      return;
    }
    for (const name of names) searchEntry(dir, name, rel === "" ? name : `${rel}/${name}`);
  };

  try {
    if (job.only === undefined) searchDir(job.dir, job.rel);
    else searchEntry(job.dir, job.only, job.rel);
    post({ done: false });
  } catch (error) {
    if (error !== STOP) throw error;
    post({ done: "max" });
  }
}

if (parentPort) run(workerData as GrepJob, (message) => parentPort!.postMessage(message));
