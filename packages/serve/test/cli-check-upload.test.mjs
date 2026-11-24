// `agentrun-serve check-upload < BODY.json` reads an upload's body on stdin and checks it as the import does. Stdin comes
// in chunks, and a character of more than one byte can be split between two of them: the body is decoded once, whole,
// so such a character reads back as itself and the package checks to the same digest the import gives it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkUpload } from "../dist/template-import.js";
import { scratch } from "./support.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
/** A file on stdin is read in chunks of this many bytes. */
const CHUNK = 64 * 1024;

const bodyOf = (pad) => ({
  files: [{ path: "agent.md", encoding: "utf8", content: `---\nname: daily-diff\nversion: 1.0.0\ndescription: Says what changed today.\n---\n${"x".repeat(pad)}é says what changed.\n` }],
});

test("agentrun-serve check-upload decodes stdin whole: a character split across two chunks reads back as itself, and the package checks to the import's own digest", async (t) => {
  // Place the two bytes of "é" on either side of the first chunk's end.
  const at = Buffer.from(JSON.stringify(bodyOf(0))).indexOf(Buffer.from("é"));
  const body = bodyOf(CHUNK - 1 - at);
  const bytes = Buffer.from(JSON.stringify(body));
  assert.deepEqual([bytes[CHUNK - 1], bytes[CHUNK]], [0xc3, 0xa9], "é straddles the chunk boundary");

  const file = join(await scratch(t), "body.json");
  writeFileSync(file, bytes);
  const fd = openSync(file, "r");
  t.after(() => closeSync(fd));
  const checked = spawnSync(process.execPath, [CLI, "check-upload"], { stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 60_000 });
  assert.equal(checked.status, 0, checked.stderr);
  const expected = checkUpload(body.files).pkg;
  assert.deepEqual(JSON.parse(checked.stdout), { valid: true, name: expected.name, sha: expected.origin.sha });
});
