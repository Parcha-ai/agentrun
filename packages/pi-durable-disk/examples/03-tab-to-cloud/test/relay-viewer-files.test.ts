// What a viewer is told of the run's work/ while a cloud host runs it. The disk's mirror rewrites files while the listing is taken, so an object can be listed and gone when it is read
// (S3 404 NoSuchKey: the take's 18 `cloud.view-failed`). The files that are there still go out, and the listing is not counted as sent, so the next tick tells the viewer the rest.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relayViewer, workSnapshot } from "../pipe/cloud.ts";
import type { FileEntry, PipeFrame } from "../wire.ts";

const gone = () => Object.assign(new Error("S3 GetObject failed: 404 NoSuchKey — The specified key does not exist"), { status: 404 });
const RUN = "r1";
const key = (p: string) => `runs/${RUN}/work/${p}`;

/** A control whose work/ holds `files`; `vanishing` names the objects whose first read is a 404 (listed, then gone). run.json is absent, as before a host started. */
function fakeControl(files: Record<string, string>, vanishing: string[] = []) {
  const reads: string[] = [];
  const vanished = new Set(vanishing);
  return {
    reads,
    control: {
      async listAll(prefix: string) {
        return Object.entries(files).map(([path, text]) => ({ key: `${prefix}${path}`, size: text.length, etag: `"${text}"` }));
      },
      async getObject(k: string) {
        reads.push(k);
        const path = k.slice(key("").length);
        if (k.endsWith("run.json")) throw Object.assign(new Error("no run.json"), { code: "NoSuchKey" });
        if (vanished.delete(path)) throw gone();
        return new TextEncoder().encode(files[path] ?? "");
      },
    } as never,
  };
}

const names = (files: FileEntry[]) => files.map((f) => f.path);

describe("workSnapshot", () => {
  it("leaves out an object that was listed and is gone, counts it, and still reads the rest", async () => {
    const { control } = fakeControl({ "skills/walk/skill.json": "{}", "skills/walk/skill-progress.jsonl": "1\n" }, ["skills/walk/skill.json"]);
    const snap = await workSnapshot(control, RUN);
    assert.deepEqual(names(snap.files), ["skills/walk/skill-progress.jsonl"]);
    assert.equal(snap.vanished, 1);
  });

  it("does not hide any other failure", async () => {
    const control = {
      listAll: async (prefix: string) => [{ key: `${prefix}a`, size: 1 }],
      getObject: async () => {
        throw Object.assign(new Error("S3 GetObject failed: 503 SlowDown"), { status: 503 });
      },
    } as never;
    await assert.rejects(workSnapshot(control, RUN), /503/);
  });
});

describe("relayViewer files", () => {
  it("sends what could be read at once, then the whole listing on the next tick, instead of never", async () => {
    const { control } = fakeControl({ "a.txt": "A", "b.txt": "B" }, ["b.txt"]);
    const frames: PipeFrame[] = [];
    const failed: string[] = [];
    const stop = await relayViewer({
      control,
      ref: { id: RUN } as never,
      send: (f) => frames.push(f),
      log: (event) => failed.push(event),
      label: () => "host",
      env: () => "vm",
      dialer: () => undefined,
    });
    try {
      const deadline = Date.now() + 5000;
      while (frames.filter((f) => f.t === "files-changed").length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    } finally {
      stop();
    }
    const lists = frames.flatMap((f) => (f.t === "files-changed" ? [names(f.files)] : []));
    assert.deepEqual(lists[0], ["a.txt"], "the first frame has what could be read");
    assert.deepEqual(lists[1], ["a.txt", "b.txt"], "the next tick lists again and tells the viewer the rest");
    assert.deepEqual(failed.filter((e) => e === "cloud.view-failed"), [], "a vanished object is not a failed view");
  });
});
