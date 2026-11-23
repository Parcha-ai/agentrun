// The zip reader (harness-zip.ts) on its own: each refusal, by the archive class that earns it, with a small cap.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";
import { zipClaiming, zipOf } from "./fixtures/zip-of.mjs";

const { unzipInto } = await import("../dist/harness-zip.js");

const file = (name, text = "x", more = {}) => ({ name, bytes: Buffer.from(text), ...more });
/** Unpacks `bytes` into a fresh folder: the folder, and the error when it was refused. */
async function unpack(bytes, options) {
  const dir = await scratch();
  const archive = join(dir, "release.zip");
  const root = join(dir, "root");
  writeFileSync(archive, bytes);
  mkdirSync(root);
  const error = await unzipInto(archive, root, options).then(() => undefined, (refused) => refused);
  return { root, error };
}

test("a zip of files and folders unpacks, each file's bytes and its execute bit kept", async () => {
  const { root, error } = await unpack(zipOf([file("bin/agent", "#!/bin/sh\n", { mode: 0o755 }), file("lib/data.txt", "data")]), { maxUnpacked: 1000 });
  assert.equal(error, undefined);
  assert.equal(readFileSync(join(root, "bin", "agent"), "utf8"), "#!/bin/sh\n");
  assert.equal(statSync(join(root, "bin", "agent")).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, "lib", "data.txt")).mode & 0o777, 0o644);
});

// Each refused before anything is written: the folder stays empty.
const BEFORE = [
  ["an absolute name", zipOf([file("/etc/agent")]), /is absolute/],
  ["a drive letter", zipOf([file("C:/agent")]), /is absolute/],
  ["a climbing name", zipOf([file("../agent")]), /leaves the archive's folder/],
  ["an empty segment", zipOf([file("bin//agent")]), /leaves the archive's folder/],
  ["a backslash", zipOf([file("bin\\agent")]), /holds a backslash/],
  ["a NUL", zipOf([file("agent\0.txt")]), /holds a NUL/],
  ["a name twice", zipOf([file("agent", "one"), file("agent", "two")]), /is in it twice/],
  ["a symlink", zipOf([file("agent", "/etc/passwd", { link: true })]), /is a symlink/],
  ["a device", zipOf([file("agent", "", { type: 0o020000 })]), /neither a file nor a folder/],
  ["an encrypted entry", zipOf([file("agent", "x", { flags: 0x1 })]), /is encrypted/],
  ["a method other than stored and deflate", zipOf([file("agent", "x", { method: 12 })]), /compressed with method 12/],
  ["more entries than the cap", zipClaiming(100_001), /holds 100001 entries, past the 100000/],
  ["one entry declared past the cap", zipOf([file("agent", "x", { size: 1001 })]), /unpacks to 1001 bytes, past the 1000/],
  ["entries declared past the cap together", zipOf([file("a", "a".repeat(600)), file("b", "b".repeat(600))]), /unpacks to 1200 bytes, past the 1000/],
];
for (const [label, bytes, refusal] of BEFORE) {
  test(`a zip with ${label} is refused before anything is written`, async () => {
    const { root, error } = await unpack(bytes, { maxUnpacked: 1000 });
    assert.match(String(error?.message), refusal);
    assert.deepEqual(readdirSync(root), [], "nothing was written");
  });
}

// An entry that inflates past its declared size stops there.
for (const [label, actual] of [["500 bytes, under the zip's cap", 500], ["1 MiB, past it (an inflate bomb)", 1024 * 1024]]) {
  test(`an entry declared as 100 bytes that inflates to ${label} stops at its declared size: no more reaches the disk`, async () => {
    const { root, error } = await unpack(zipOf([file("agent", "\0".repeat(actual), { size: 100 })]), { maxUnpacked: 1000 });
    assert.match(String(error?.message), /"agent" unpacks past the size its directory says/);
    assert.ok(statSync(join(root, "agent")).size <= 100, "never past the declared size");
  });
}

test("an entry that unpacks short of its declared size, or fails its CRC-32, is refused", async () => {
  const short = await unpack(zipOf([file("agent", "four", { size: 8 })]), { maxUnpacked: 1000 });
  assert.match(String(short.error?.message), /"agent" unpacks to 4 bytes, and its directory says 8/);
  const crc = await unpack(zipOf([file("agent", "four", { crc: 0x12345678 })]), { maxUnpacked: 1000 });
  assert.match(String(crc.error?.message), /"agent" fails its CRC-32/);
});
