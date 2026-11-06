// The tools benchmark's fixes to the pi-shaped tools (native-tools bench, 2026-11-06): bash says and keeps a default and
// a ceiling for its timeout, and read opens an image anywhere in the run's box, through the box, never on this machine.
import assert from "node:assert/strict";
import test from "node:test";
import { codingSource } from "../dist/coding-tools.js";

const BOX = { mode: "sandbox", box: "docker" };
const api = (seen = []) => ({ env: { cwd: "/host" }, output: (chunk) => seen.push(chunk), outputWindow: undefined, retainedOutput: () => ({ text: "", truncated: false }), diagnostic() {}, callId: "c1" });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");

/** A box whose exec records the timeout each command was given, and answers `timedOut` commands as a timeout. */
function bashBox(timedOut = false) {
  const timeouts = [];
  const env = { cwd: "/run/agentrun/run/work", exec: async (command, options) => (timeouts.push(options.timeout), timedOut ? { ok: false, error: { code: "timeout", message: "timeout" } } : { ok: true, value: { exitCode: 0 } }) };
  return { timeouts, source: codingSource(BOX, { env: async () => env }) };
}

test("bash says its timeout: 120 s by default, at most 600 s, and bash_background for longer work, in its description and its timeout's", () => {
  const bash = bashBox().source.tools.find((tool) => tool.name === "bash");
  assert.match(bash.description, /120 s by default/);
  assert.match(bash.description, /at most 600 s/);
  assert.match(bash.description, /bash_background/);
  const timeout = bash.parameters.properties.timeout;
  assert.match(timeout.description, /120/);
  assert.match(timeout.description, /600/);
  assert.doesNotMatch(timeout.description, /no default timeout/);
  assert.equal(timeout.type, "number", "the schema's shape is pi's: only the words change");
});

test("bash with no timeout runs at the 120 s default; one under the ceiling keeps its own", async () => {
  const { timeouts, source } = bashBox();
  const bash = source.tools.find((tool) => tool.name === "bash");
  await bash.execute({ command: "true" }, api(), {});
  await bash.execute({ command: "true", timeout: 30 }, api(), {});
  assert.deepEqual(timeouts, [120, 30]);
});

test("bash asked for more than 600 s runs at 600 s and says so: in a diagnostic when it ends, in its error when it times out", async () => {
  const ok = bashBox();
  const bash = ok.source.tools.find((tool) => tool.name === "bash");
  const result = await bash.execute({ command: "make", timeout: 3000 }, api(), {});
  assert.deepEqual(ok.timeouts, [600]);
  assert.match(JSON.stringify(result.diagnostics ?? []), /at most 600 s.*3000 s/s, JSON.stringify(result));
  const slow = bashBox(true);
  const timedOut = slow.source.tools.find((tool) => tool.name === "bash");
  await assert.rejects(timedOut.execute({ command: "./brute", timeout: 3000 }, api(), {}), /600.*3000 s.*bash_background/s);
  assert.deepEqual(slow.timeouts, [600]);
});

/** A box that holds `files` (absolute box paths to bytes) and records each path it was asked for. */
function fileBox(files, hostWork) {
  const asked = [];
  const env = { cwd: "/run/agentrun/run/work", readBinaryFile: async (path) => (asked.push(path), path in files ? { ok: true, value: new Uint8Array(files[path]) } : { ok: false, error: { code: "not_found", message: `${path}: not found` } }) };
  return { asked, source: codingSource(BOX, { ...(hostWork ? { hostWork } : {}), env: async () => env }) };
}

test("read opens an image the model rendered outside work/, at a path in the run's box, and answers it as an image", async () => {
  const { asked, source } = fileBox({ "/tmp/view/frame.png": PNG });
  const read = source.tools.find((tool) => tool.name === "read");
  const result = await read.execute({ path: "/tmp/view/frame.png" }, api(), {});
  assert.deepEqual(asked, ["/tmp/view/frame.png"], "read through the box, at the box's own path");
  assert.equal(result.content?.[0]?.type, "image", JSON.stringify(result).slice(0, 300));
  assert.equal(result.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(result.content[0].data, "base64").equals(PNG), true);
  assert.match(read.description, /image/i, "read says it opens images");
});

test("read outside work/ stays confined for anything but an image: a text file in /tmp, a file named .png that is not one, a host path", async () => {
  const { source } = fileBox({ "/tmp/notes.txt": Buffer.from("secret"), "/tmp/fake.png": Buffer.from("not an image at all") });
  const read = source.tools.find((tool) => tool.name === "read");
  for (const path of ["/tmp/notes.txt", "/tmp/fake.png", "/etc/hostname", "~/a.png", "file:///tmp/a.png"]) {
    await assert.rejects(read.execute({ path }, api(), {}), { name: "PathOutsideWorkError" }, path);
  }
});

test("write and edit outside work/ stay refused, an image path included", async () => {
  const { asked, source } = fileBox({});
  for (const name of ["write", "edit"]) {
    const tool = source.tools.find((t) => t.name === name);
    await assert.rejects(tool.execute({ path: "/tmp/a.png", content: "x", edits: [] }, api(), {}), { name: "PathOutsideWorkError" }, name);
  }
  assert.deepEqual(asked, []);
});

test("on the runner (no box) read keeps pi's own confinement: an image outside work/ is refused, never read on this machine", async () => {
  const { tools } = codingSource({ mode: "runner" });
  const read = tools.find((tool) => tool.name === "read");
  assert.doesNotMatch(read.description, /any path in the run's box/);
});
