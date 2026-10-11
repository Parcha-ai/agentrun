// The bench's runner: a provider that is not built prints one `not built` row and runs nothing, and a built one runs its job
// on each file, measured, while a job that throws prints the first line of its error. The Node environment is not built
// yet, so the built path runs with the testing kit's fake provider and a file reader here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { notBuilt } from "@parcha/pi-vision";
import { fakeProvider, fixtureDir } from "@parcha/pi-vision/testing";
import { jobRows, writeFiles } from "../bench/support.mjs";

const fileEnv = { id: "bench-test", cwd: "/", readBinaryFile: async (path) => ({ ok: true, value: new Uint8Array(await readFile(path)) }) };
const document = (text) => new TextEncoder().encode(JSON.stringify({ pages: [{ text, width: 612, height: 792 }] }));

test("a provider that is not built prints one row that says so, and runs nothing", async () => {
  const dir = await fixtureDir("pi-vision-bench-test-");
  try {
    const files = await writeFiles(dir, { "a.json": { kind: "pdf", bytes: document("alpha") } });
    const rows = await jobRows({
      label: "unbuilt", job: "text", make: () => notBuilt("the unbuilt provider"), cwd: dir.path, files, env: () => fileEnv,
      run: () => assert.fail("a job of a provider that is not built must not run"),
    });
    assert.deepEqual(rows, [["unbuilt", "text", "-", "not built", "-", "-", "-"]]);
  } finally {
    await dir.remove();
  }
});

test("a built provider runs its job on each file, and a job that throws shows the first line of its error", async () => {
  const dir = await fixtureDir("pi-vision-bench-test-");
  try {
    const files = await writeFiles(dir, { "a.json": { kind: "pdf", bytes: document("alpha") }, "b.json": { kind: "pdf", bytes: document("bravo!") } });
    const rows = await jobRows({
      label: "fake", job: "text", make: () => fakeProvider(), cwd: dir.path, files, env: () => fileEnv,
      run: async (provider, file, call) => {
        if (file.source.path.endsWith("b.json")) throw new Error("the first line\nthe second line");
        const out = await provider.text(file.source, {}, call);
        return { bytes: Buffer.byteLength(out.pages[0].text), pixels: "-" };
      },
    });
    assert.equal(rows.length, 2);
    const [measured, failed] = rows;
    assert.deepEqual(measured.slice(0, 3), ["fake", "text", "a.json"]);
    assert.match(measured[3], /^\d+\.\d$/, "the time of a job that ran");
    assert.deepEqual(measured.slice(4, 6), [5, "-"]);
    assert.deepEqual(failed.slice(0, 6), ["fake", "text", "b.json", "error: the first line", "-", "-"]);
  } finally {
    await dir.remove();
  }
});
