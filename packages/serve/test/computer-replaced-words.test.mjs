// The words a run resumed on a fresh computer is told (computer-deps.ts): the owner's ready line, and the one note the
// model's next request carries (computerReplacedNote), by kind and mode, exactly. The note names no cause (a lost runner,
// a crash, a server's stop and a park all leave a fresh computer) and is labelled as the server's, as the cap's wrap-up is.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../dist/workspace/index.js";
import { computerReadyWords, computerReplacedNote } from "../dist/workspace/computer-deps.js";

const HELLO = { os: "linux", arch: "amd64" };

test("the owner's ready line on a fresh computer: it's a new one, the one before gone with what was on it; in Mode 2 with the folder mounted, the run folder is kept", () => {
  for (const kind of ["desktop", "sandbox", "phone"]) {
    const ready = computerReadyWords({ provider: "E2B", kind, hello: HELLO, replaced: { kind, folderKept: false } });
    assert.equal(ready, `The ${kind} is ready: Linux (amd64), from E2B. It's a new ${kind}: the one before is gone, with what was on it.`);
    const kept = computerReadyWords({ provider: "E2B", kind, hello: HELLO, replaced: { kind, folderKept: true } });
    assert.equal(kept, `The ${kind} is ready: Linux (amd64), from E2B. It's a new ${kind}: the one before is gone, with what was on it. The run folder is kept.`);
  }
});

test("the model's note, each kind and mode, exactly", () => {
  const screen = "AgentRun server note: your computer was replaced. The earlier one is gone, with its screen and refs. Look at the screen again before acting.";
  for (const kind of ["desktop", "phone"]) {
    assert.equal(computerReplacedNote({ kind, folderKept: false }), screen, `${kind}, Mode 1`);
    assert.equal(computerReplacedNote({ kind, folderKept: true }), `${screen} The run folder is kept.`, `${kind}, Mode 2`);
  }
  assert.equal(computerReplacedNote({ kind: "sandbox", folderKept: false }), "AgentRun server note: your computer was replaced. The earlier one is gone, with its files and processes. Check its files again before relying on them.", "sandbox, Mode 1");
  assert.equal(computerReplacedNote({ kind: "sandbox", folderKept: true }), "AgentRun server note: your computer was replaced. The earlier one is gone, with its files and processes. The run folder is kept; anything outside it is gone.", "sandbox, Mode 2");
});
