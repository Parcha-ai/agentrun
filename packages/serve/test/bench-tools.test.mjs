// The tools benchmark's fixes to the pi-shaped tools (native-tools bench, 2026-11-06): bash says and keeps a default and
// a ceiling for its timeout, and read opens an image anywhere in the run's box, through the box, never on this machine.
import assert from "node:assert/strict";
import test from "node:test";
import { codingSource, READ_IMAGE_MAX_BYTES } from "../dist/coding-tools.js";

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

/** A box that holds `files` (absolute box paths to bytes). It runs only the bounded read (`head -c "$2" -- "$1" | base64`,
 *  `$2` the most bytes it may send), as a shell in the box would: what each command asked for, and the bytes it sent. */
function fileBox(files, hostWork) {
  const asked = [];
  const sent = [];
  const env = {
    cwd: "/run/agentrun/run/work",
    exec: async (command, options) => {
      const [, , script, , path, limit] = command;
      asked.push({ path, limit: Number(limit), script });
      if (!(path in files)) {
        options.onOutput?.(`head: ${path}: No such file or directory`, {}, { stream: "stderr" });
        return { ok: true, value: { exitCode: 1 } };
      }
      const held = Buffer.from(files[path]).subarray(0, Number(limit));
      sent.push(held.length);
      options.onOutput?.(held.toString("base64"), {}, { stream: "stdout" });
      return { ok: true, value: { exitCode: 0 } };
    },
  };
  return { asked, sent, source: codingSource(BOX, { ...(hostWork ? { hostWork } : {}), env: async () => env }) };
}

test("read opens an image the model rendered outside work/, at a path in the run's box, and answers it as an image under pi's result key", async () => {
  const { asked, source } = fileBox({ "/tmp/view/frame.png": PNG });
  const read = source.tools.find((tool) => tool.name === "read");
  const result = await read.execute({ path: "/tmp/view/frame.png" }, api(), {});
  assert.deepEqual(asked.map((a) => [a.path, a.limit]), [["/tmp/view/frame.png", READ_IMAGE_MAX_BYTES + 1]], "read through the box, at the box's own path, at most one byte over the bound");
  assert.match(asked[0].script, /head -c "\$2" -- "\$1" \| base64/);
  // pi 1.5 reads a result's blocks under `output` only (result.ts).
  assert.equal("content" in result, false, "no pi 1.1 `content` key beside it");
  for (const key of ["output"]) {
    const image = result[key]?.find((block) => block.type === "image");
    assert.ok(image, `${key}: ${JSON.stringify(result).slice(0, 300)}`);
    assert.deepEqual(Object.keys(image).sort(), ["data", "mimeType", "type"]);
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").equals(PNG), true);
    assert.match(result[key].find((block) => block.type === "text")?.text ?? "", /\/tmp\/view\/frame\.png.*image\/png/, "a line of text names it, so no answer is an empty text");
  }
  assert.match(read.description, /image/i, "read says it opens images");
});

test("an image over read's bound is refused, and the box sends at most one byte past the bound: the server never holds the whole file", async () => {
  const big = Buffer.concat([PNG.subarray(0, 16), Buffer.alloc(6 * 1024 * 1024)]);
  const { asked, sent, source } = fileBox({ "/tmp/big.png": big });
  const read = source.tools.find((tool) => tool.name === "read");
  await assert.rejects(read.execute({ path: "/tmp/big.png" }, api(), {}), new RegExp(`/tmp/big\\.png is an image over read's ${READ_IMAGE_MAX_BYTES} bytes`));
  assert.deepEqual(asked.map((a) => a.limit), [READ_IMAGE_MAX_BYTES + 1]);
  assert.deepEqual(sent, [READ_IMAGE_MAX_BYTES + 1], "the box sent max + 1 bytes of the 6 MB, no more");
});

test("an image path the box can't read, or whose bytes are no image, is refused in words of its own, not as outside the workspace", async () => {
  const { source } = fileBox({ "/tmp/fake.png": Buffer.from("not an image at all") });
  const read = source.tools.find((tool) => tool.name === "read");
  await assert.rejects(read.execute({ path: "/tmp/missing.png" }, api(), {}), (error) => error.message === "/tmp/missing.png could not be read in the box" && error.name !== "PathOutsideWorkError");
  await assert.rejects(read.execute({ path: "/tmp/fake.png" }, api(), {}), (error) => error.message === "/tmp/fake.png is not an image" && error.name !== "PathOutsideWorkError");
});

test("read outside work/ stays confined for anything but an image: a text file in /tmp, a host path", async () => {
  const { source } = fileBox({ "/tmp/notes.txt": Buffer.from("secret") });
  const read = source.tools.find((tool) => tool.name === "read");
  for (const path of ["/tmp/notes.txt", "/etc/hostname", "~/a.png", "file:///tmp/a.png"]) {
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
