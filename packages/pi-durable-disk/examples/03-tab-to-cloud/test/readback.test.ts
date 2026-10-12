// The opt-in durability check: after a release, work/ is read back from the object store (here a local fake over the
// claims' directory) and compared with what the pipe kept and what the leaving tab acknowledged; a corrupted object is
// named by path, never by content; off, nothing is read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ReadbackSource } from "../pipe/readback.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { toBase64, workspaceDigest, type PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

const text = (s: string) => toBase64(new TextEncoder().encode(s));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The object store's view of a local "disk": keys under `root`, a directory as `<path>/`; `corrupt` keys read wrong. */
function localStore(root: () => string, corrupt: Set<string>, reads: string[]): ReadbackSource {
  return {
    async list(prefix) {
      const out: { key: string; size: number; lastModified?: Date }[] = [];
      const walk = (rel: string) => {
        for (const name of readdirSync(join(root(), rel))) {
          const key = `${rel}${name}`;
          const info = statSync(join(root(), key));
          if (info.isDirectory()) {
            out.push({ key: `${key}/`, size: 0 });
            walk(`${key}/`);
          } else out.push({ key, size: info.size, lastModified: info.mtime });
        }
      };
      walk(prefix);
      return out;
    },
    async get(key) {
      reads.push(key);
      const bytes = new Uint8Array(readFileSync(join(root(), key)));
      if (corrupt.has(key)) bytes[0] = bytes[0]! ^ 0xff;
      return bytes;
    },
  };
}

const cloud: CloudHost = {
  environments: [{ id: "far", label: "Far away", phrase: "a far-away host", kind: "cloud" }],
  start: async () => ({ host: "far-1" }),
  stop: async () => undefined,
};

describe("the release's readback", () => {
  const corrupt = new Set<string>();
  const reads: string[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let on: Awaited<ReturnType<typeof localServer>>;
  let off: Awaited<ReturnType<typeof localServer>>;
  before(async () => {
    on = await localServer({ cloud, drainMs: 2_000, evidenceReadback: localStore(() => on.root, corrupt, reads), log: (event, data = {}) => events.push({ event, data }) });
    off = await localServer({ cloud, drainMs: 2_000, log: (event, data = {}) => events.push({ event, data: { ...data, off: true } }) });
  });
  after(async () => {
    await on.remove();
    await off.remove();
  });

  const until = async (check: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; events: ${events.slice(-6).map((e) => e.event).join(", ")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /** A tab writes two files and switches the run to the cloud, saying what it had acknowledged. */
  const writeAndLeave = async (server: Awaited<ReturnType<typeof localServer>>, run: string) => {
    const { id, secret } = await server.server.createRun(run);
    const acked = await workspaceDigest(["directory notes", `file notes/a.txt ${sha("the first file\n")}`, `file b.txt ${sha("the second\n")}`]);
    const a: PipeClient = new PipeClient({
      url: server.url, run: id, token: secret, tab: "a", mode: "write",
      onFrame: (f: PipeFrame) => f.t === "drain" && a.send({ t: "drained", switchId: f.switchId, acked }),
    });
    await a.ready;
    await a.syncFiles([
      { path: "notes", op: "mkdir" },
      { path: "notes/a.txt", op: "write", data: text("the first file\n") },
      { path: "b.txt", op: "write", data: text("the second\n") },
    ]);
    a.send({ t: "switch", to: "far" });
    const state = server.server.runs.get(id)!;
    await until(() => state.placement.where === "cloud");
    a.close();
    return { id, acked };
  };

  it("matches what the pipe kept and what the tab acknowledged", async () => {
    const { id, acked } = await writeAndLeave(on, "rb-match");
    await until(() => events.some((e) => e.event === "pipe.readback" && e.data.run === id));
    const line = events.find((e) => e.event === "pipe.readback" && e.data.run === id)!.data;
    assert.equal(line.match, true);
    assert.equal(line.ackedMatch, true);
    assert.equal(line.digest, acked);
    assert.equal(line.kept, acked);
    assert.equal(line.files, 2);
    assert.equal(typeof line.ms, "number");
    assert.equal(typeof line.startedAfterMs, "number");
    assert.ok(!events.some((e) => e.event === "pipe.readback-mismatch" && e.data.run === id));
  });

  it("names a file the object store holds differently, by path and never by content", async () => {
    corrupt.add("runs/rb-mismatch/work/notes/a.txt");
    const { id } = await writeAndLeave(on, "rb-mismatch");
    await until(() => events.some((e) => e.event === "pipe.readback-mismatch" && e.data.run === id));
    const line = events.find((e) => e.event === "pipe.readback" && e.data.run === id)!.data;
    assert.equal(line.match, false);
    assert.equal(line.ackedMatch, false);
    const mismatch = events.find((e) => e.event === "pipe.readback-mismatch" && e.data.run === id)!.data;
    assert.deepEqual(mismatch.differ, ["notes/a.txt"]);
    assert.deepEqual(mismatch.missing, []);
    assert.deepEqual(mismatch.extra, []);
    const logged = JSON.stringify(events.filter((e) => e.data.run === id));
    assert.ok(!logged.includes("the first file") && !logged.includes("the second"), "no content in the log");
  });

  it("reads nothing when it is off", async () => {
    const before = reads.length;
    const { id } = await writeAndLeave(off, "rb-off");
    await until(() => events.some((e) => e.event === "pipe.released" && e.data.run === id));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!events.some((e) => e.event === "pipe.readback" && e.data.run === id));
    assert.equal(reads.length, before);
  });
});
