// readRunFile and listRunFiles over a fake control that answers as Archil's S3 API does (D2's measurements, archil
// 0.8.42): a missing key is 404, a symlink is listed as an ordinary zero-byte key but its HEAD and GET answer 501, and a
// directory is a marker key ending in "/". Every call is recorded, so a test can say what was asked and that nothing wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listRunFiles, readRunFile, RunFileError, type RunFileControl } from "../src/run-files.ts";
import type { ArchilControl } from "../src/supervise.ts";

// The disk's own control serves these reads as it is (checked by the compiler).
const archilReads: ArchilControl extends RunFileControl ? true : never = true as const;
void archilReads;

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const RUN = `runs/${REF.id}/`;
const err = (status: number, code: string) => Object.assign(new Error(`${status} ${code}`), { status, code });

type Entry = { kind: "file"; bytes: Uint8Array } | { kind: "symlink" } | { kind: "dir" };

function fakeControl(entries: Record<string, Entry> = {}) {
  const objects = new Map<string, Entry>(Object.entries(entries));
  const calls: string[] = [];
  const faults = new Map<string, Error>();
  let hang = false;
  const control: RunFileControl & { putObject(): never } = {
    async getObject(key) {
      calls.push(`get ${key}`);
      if (hang) return new Promise<Uint8Array>(() => {});
      const fault = faults.get(key);
      if (fault) throw fault;
      const e = objects.get(key);
      if (!e) throw err(404, "NoSuchKey");
      if (e.kind === "symlink") throw err(501, "NotImplemented");
      return e.kind === "file" ? e.bytes : new Uint8Array();
    },
    async headObject(key) {
      calls.push(`head ${key}`);
      const fault = faults.get(key);
      if (fault) throw fault;
      const e = objects.get(key);
      if (!e) return null;
      if (e.kind === "symlink") throw err(501, "NotImplemented");
      return { size: e.kind === "file" ? e.bytes.length : 0 };
    },
    async listObjects(prefix) {
      calls.push(`list ${prefix}`);
      const under = [...objects.keys()].filter((k) => k.startsWith(prefix) && k !== prefix);
      const direct = under.filter((k) => !k.slice(prefix.length).replace(/\/$/, "").includes("/"));
      return {
        // A symlink is listed as an ordinary key of size 0, so a listing cannot tell it from an empty file.
        objects: direct.filter((k) => !k.endsWith("/")).map((key) => ({ key, size: objects.get(key)!.kind === "file" ? (objects.get(key) as { bytes: Uint8Array }).bytes.length : 0 })),
        commonPrefixes: direct.filter((k) => k.endsWith("/")),
      };
    },
    putObject() {
      calls.push("put");
      throw new Error("a read wrote");
    },
  };
  return { control, calls, faults, setHang: (v: boolean) => (hang = v), objects };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const run = (more: Record<string, Entry> = {}) => fakeControl({ [RUN]: { kind: "dir" }, ...more });

test("readRunFile: a file's bytes; a missing file is null; a missing run is RUN_MISSING; nothing is ever written", async () => {
  const f = run({ [`${RUN}box-ids.internal/`]: { kind: "dir" }, [`${RUN}box-ids.internal/box-1.json`]: { kind: "file", bytes: bytes('{"owner":"place"}') } });
  assert.deepEqual(await readRunFile(f.control, REF, "box-ids.internal/box-1.json"), bytes('{"owner":"place"}'));
  assert.equal(await readRunFile(f.control, REF, "box-ids.internal/box-2.json"), null, "not there yet: a poller waits");
  const none = fakeControl();
  await assert.rejects(readRunFile(none.control, REF, "run.json"), (e: unknown) => e instanceof RunFileError && e.code === "RUN_MISSING");
  assert.ok(![...f.calls, ...none.calls].includes("put"), "a read never writes");
});

test("readRunFile: a symlink (listed as an empty file, but its GET answers 501) is NOT_A_FILE; a real empty file reads as empty; a directory is NOT_A_FILE", async () => {
  const f = run({ [`${RUN}link.json`]: { kind: "symlink" }, [`${RUN}empty.json`]: { kind: "file", bytes: new Uint8Array() }, [`${RUN}work/`]: { kind: "dir" } });
  const listed = await f.control.listObjects(RUN);
  assert.deepEqual(listed.objects.filter((o) => o.key.endsWith(".json")).map((o) => o.size), [0, 0], "the listing shows both as zero-byte files");
  await assert.rejects(readRunFile(f.control, REF, "link.json"), (e: unknown) => e instanceof RunFileError && e.code === "NOT_A_FILE" && /link\.json/.test(e.message));
  const empty = await readRunFile(f.control, REF, "empty.json");
  assert.ok(empty instanceof Uint8Array && empty.length === 0, "a real empty file is an empty array, not null and not refused");
  await assert.rejects(readRunFile(f.control, REF, "work"), (e: unknown) => e instanceof RunFileError && e.code === "NOT_A_FILE");
});

test("every path that is not a relative path of safe segments inside the run is INVALID_PATH, refused before any request", async () => {
  const f = run();
  for (const bad of ["", "/run.json", "a//b", "a/./b", "./a", "../x", "a/..", "a/../b", "bad name.json", "a/", ".archil/client-1", "x\u0000y", "a\\b"]) {
    await assert.rejects(readRunFile(f.control, REF, bad), (e: unknown) => e instanceof RunFileError && e.code === "INVALID_PATH", JSON.stringify(bad));
    await assert.rejects(listRunFiles(f.control, REF, bad === "" ? "../x" : bad), (e: unknown) => e instanceof RunFileError && e.code === "INVALID_PATH", `list ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(f.calls, [], "no request was made for any of them");
});

test("an INVALID_PATH message names what is wrong, never the path it was given", async () => {
  const f = run();
  const secret = `sk-${"7f3a".repeat(40)}`;
  for (const [bad, why] of [[`/${secret}`, /absolute/], [`${secret}/../x`, /"\.\."/], [`${secret} x`, /unsafe character at index \d+/], [`.archil/${secret}`, /\.archil/], ["", /empty/], [`a//${secret}`, /empty segment/]] as const) {
    await assert.rejects(readRunFile(f.control, REF, bad), (e: unknown) => {
      assert.ok(e instanceof RunFileError && e.code === "INVALID_PATH", String(e));
      assert.match((e as Error).message, why);
      assert.ok(!(e as Error).message.includes(secret.slice(0, 16)), `no echo: ${(e as Error).message}`);
      return true;
    });
  }
});

test("listRunFiles: the names directly under a directory, sorted, names only (no marker, nothing deeper); the run's root with an empty dir", async () => {
  const f = run({
    [`${RUN}box-ids.internal/`]: { kind: "dir" },
    [`${RUN}box-ids.internal/box-10.json`]: { kind: "file", bytes: bytes("{}") },
    [`${RUN}box-ids.internal/box-2.json`]: { kind: "file", bytes: bytes("{}") },
    [`${RUN}box-ids.internal/.tmp-12-abcd1234`]: { kind: "file", bytes: bytes("") },
    [`${RUN}box-ids.internal/sub/`]: { kind: "dir" },
    [`${RUN}box-ids.internal/sub/deep.json`]: { kind: "file", bytes: bytes("{}") },
    [`${RUN}run.json`]: { kind: "file", bytes: bytes("{}") },
  });
  assert.deepEqual(await listRunFiles(f.control, REF, "box-ids.internal"), [".tmp-12-abcd1234", "box-10.json", "box-2.json", "sub"]);
  assert.deepEqual(await listRunFiles(f.control, REF, ""), ["box-ids.internal", "run.json"]);
  assert.deepEqual(await listRunFiles(f.control, REF, "not-made-yet"), [], "a directory not made yet lists nothing");
  await assert.rejects(listRunFiles(fakeControl().control, REF, "x"), (e: unknown) => e instanceof RunFileError && e.code === "RUN_MISSING");
  assert.ok(!f.calls.includes("put"));
});

test("a control failure other than 404 or 501 is CONTROL_API_FAILED with its cause, and no file content in the message", async () => {
  const f = run({ [`${RUN}secret.json`]: { kind: "file", bytes: bytes("TOP-SECRET-CONTENT") } });
  const cause = err(503, "SlowDown");
  f.faults.set(`${RUN}secret.json`, cause);
  await assert.rejects(readRunFile(f.control, REF, "secret.json"), (e: unknown) => {
    assert.ok(e instanceof RunFileError && e.code === "CONTROL_API_FAILED", String(e));
    assert.equal((e as { cause?: unknown }).cause, cause);
    assert.doesNotMatch((e as Error).message, /TOP-SECRET-CONTENT/);
    return true;
  });
});

test("a signal: an aborted one makes no request; one aborted while a request hangs ends the wait at once", async () => {
  const f = run({ [`${RUN}run.json`]: { kind: "file", bytes: bytes("{}") } });
  const aborted = AbortSignal.abort(new Error("stopped"));
  await assert.rejects(readRunFile(f.control, REF, "run.json", { signal: aborted }), /stopped/);
  await assert.rejects(listRunFiles(f.control, REF, "", { signal: aborted }), /stopped/);
  assert.deepEqual(f.calls, [], "nothing asked");
  f.setHang(true);
  const ac = new AbortController();
  const t0 = Date.now();
  const pending = readRunFile(f.control, REF, "run.json", { signal: ac.signal });
  setTimeout(() => ac.abort(new Error("caller gave up")), 50);
  await assert.rejects(pending, /caller gave up/);
  assert.ok(Date.now() - t0 < 1_000, "the hanging request no longer holds the caller");
});
