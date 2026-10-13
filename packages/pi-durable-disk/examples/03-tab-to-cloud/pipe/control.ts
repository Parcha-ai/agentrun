// The disk's control API for the server (it holds the Archil key; the tab and the cloud host never do), and a ledger
// of every resource the demo creates on the disk, so a run of the demo can prove it left nothing behind.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CheckControl, ControlApi, SupervisorControl } from "@parcha/pi-durable-disk";

export type DemoControl = SupervisorControl &
  CheckControl &
  ControlApi & {
    /** Every object under `prefix`, all pages, with its size and modification time. */
    listAll(prefix: string): Promise<{ key: string; size: number; lastModified?: Date }[]>;
  };

export async function archilControl(opts: { disk: string; region: string; apiKey: string }): Promise<DemoControl> {
  const { configure, getDisk } = await import("disk");
  configure({ apiKey: opts.apiKey, region: opts.region });
  const disk = await getDisk(opts.disk);
  return {
    getObject: (key) => disk.getObject(key),
    headObject: (key) => disk.headObject(key),
    putObject: (key, body, options) => disk.putObject(key, body, options),
    addUser: (user) => disk.addUser(user),
    removeUser: (type, identifier) => disk.removeUser(type, identifier),
    listDelegations: () => disk.listDelegations(),
    revokeDelegation: (d) => disk.revokeDelegation(d),
    exec: (command) => disk.exec(command),
    listObjects: (prefix, options) => disk.listObjects(prefix, options),
    deleteObjects: (keys, options) => disk.deleteObjects(keys, options),
    async listAll(prefix: string) {
      const out: { key: string; size: number; lastModified?: Date }[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await disk.listObjects(prefix, { recursive: true, ...(continuationToken ? { continuationToken } : {}) });
        out.push(...page.objects);
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return out;
    },
  } as DemoControl;
}

export type LedgerRow = { kind: string; id: string; at: string; closed?: string; note?: string };

/** Rows in a JSON file: `open` records a resource, `close` marks it gone; `openRows` lists what is left. */
export class Ledger {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ about: "every resource the tab-to-cloud demo created", rows: [] }, null, 1));
  }
  #read(): { about: string; rows: LedgerRow[] } {
    return JSON.parse(readFileSync(this.file, "utf8"));
  }
  #write(data: { about: string; rows: LedgerRow[] }): void {
    writeFileSync(this.file, `${JSON.stringify(data, null, 1)}\n`);
  }
  open(kind: string, id: string, note?: string): void {
    const data = this.#read();
    data.rows.push({ kind, id, at: new Date().toISOString(), ...(note ? { note } : {}) });
    this.#write(data);
  }
  close(kind: string, id: string, note?: string): void {
    const data = this.#read();
    for (const row of data.rows) if (row.kind === kind && row.id === id && !row.closed) {
      row.closed = new Date().toISOString();
      if (note) row.note = row.note ? `${row.note}; ${note}` : note;
    }
    this.#write(data);
  }
  openRows(): LedgerRow[] {
    return this.#read().rows.filter((r) => !r.closed);
  }
}

let stdioQuiet = false;
let stdoutGone = false;
/**
 * A reader that went away (the harness that started the server died, a pipe was closed) is not a reason for the server to fail, and certainly not to loop. A write to a closed pipe is an `error` event on
 * the stream; with no listener it became an uncaught exception, whose handler logged (another failed write, another error), and the endless chain of errors starved the event loop: 98% CPU for 19 hours, no
 * timer or signal served again. The errors are listened to here, and once stdout is gone it is not written to again (the log file, when there is one, still is).
 */
function quietStdio(): void {
  if (stdioQuiet) return;
  stdioQuiet = true;
  process.stdout.on("error", () => { stdoutGone = true; });
  process.stderr.on("error", () => undefined);
}

/** A one-line JSON log on stdout, and appended to `file` when given. */
export function jsonLog(file?: string) {
  quietStdio();
  return (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
    // a log line is never a reason to fail: a log file that cannot be written (its directory is gone, the disk is full) is skipped, so the server's shutdown and its cleanup always run
    if (file) {
      try {
        appendFileSync(file, `${line}\n`);
      } catch {
        /* the file is unwritable now: stdout still gets the line */
      }
    }
    if (!stdoutGone && !process.stdout.destroyed) console.log(line);
  };
}
