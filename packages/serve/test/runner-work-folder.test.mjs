// The runner makes the run's Workspace folder at the claim: the server's start made it before (design 2.1), so a pi run
// claimed on the runner must have its work folder there before its tools are built over it, else its first turn fails
// "the run's .../work folder is not there". A fresh, never-run run's spec builds, and its folder is there afterward.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";

test("a fresh, never-run run's spec builds and the runner has made its work folder", async (t) => {
  const { workFolder } = await specFor(t, { body: { tools: [] } });
  assert.equal(existsSync(workFolder), true, "the run's work folder is there after the spec is built");
});

test("the runner copies the run's uploaded files into work/inputs/ before the first turn", async (t) => {
  const { workFolder } = await specFor(t, { uploads: [{ path: "notes.txt", text: "the brief" }, { path: "docs/plan.md", text: "# plan" }] });
  assert.equal(readFileSync(join(workFolder, "inputs", "notes.txt"), "utf8"), "the brief");
  assert.equal(readFileSync(join(workFolder, "inputs", "docs", "plan.md"), "utf8"), "# plan");
});
