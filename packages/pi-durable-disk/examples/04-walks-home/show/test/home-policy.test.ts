import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkHomePolicy } from "../home-policy.ts";
import { dummyPolicy } from "../../tab/src/dummy.ts";
import { defaultDesign, PRESETS, type Design } from "../../tab/src/design.ts";
import { buildMjcf } from "../../tab/src/mjcf.ts";
import { sha256Hex } from "../../tab/src/policy.ts";

// The home beat's policy, checked before the take: the 404 a rehearsal storyboard caught on camera, and every refusal the tab's
// own code would show, are preflight failures. Policies are the tab's own dummy (a valid mlp-v1 for any body), so the fixtures
// cannot drift from what the tab accepts.
const MUJOCO = "3.15.0";
const tabDir = mkdtempSync(join(tmpdir(), "home-policy-tab-"));
writeFileSync(join(tabDir, "versions.json"), JSON.stringify({ mujoco: MUJOCO }));

async function policyFor(design: Design, patch: Record<string, unknown> = {}): Promise<string> {
  const built = buildMjcf(design);
  const file = dummyPolicy({ mjcfSha256: await sha256Hex(built.xml), mujocoVersion: MUJOCO, nj: built.jointNames.length, jointsPerLeg: built.jointsPerLeg });
  return JSON.stringify({ ...file, ...patch });
}
function policyDir(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "home-policy-"));
  if (text !== undefined) writeFileSync(join(dir, "home.json"), text);
  return dir;
}
const staticTake = (dir?: string, tab = tabDir) => checkHomePolicy({ POLICY_DIR: dir, TAB_DIR: tab });

test("no POLICY_DIR: a failure that says to set it (the stage would serve a folder a fresh worktree does not have)", async () => {
  const [ok, note] = await staticTake(undefined);
  assert.equal(ok, false);
  assert.match(note, /POLICY_DIR is not set/);
});

test("a POLICY_DIR without home.json: a failure naming the refusal the camera would see", async () => {
  const [ok, note] = await staticTake(policyDir());
  assert.equal(ok, false);
  assert.match(note, /could not fetch \/policy\/home\.json: HTTP 404/);
});

test("a home.json the tab's own code refuses fails with the tab's reason", async () => {
  const cases: [string, string, RegExp][] = [
    ["not JSON", "{ nope", /not valid JSON/],
    ["another format", await policyFor(defaultDesign(), { format: "onnx" }), /unknown format/],
    // Passes a shape check (mlp-v1, MuJoCo 3.15.0, a sha string); the tab's Policy.load refuses it.
    ["another control step", await policyFor(defaultDesign(), { control_dt: 0.05 }), /control_dt 0\.05/],
    ["a body that is neither the start body nor a preset", await policyFor({ ...PRESETS.stubby!, torso: { length: 0.61, width: 0.3, height: 0.14 } }), /neither the one on screen nor a preset/],
    ["another MuJoCo", await policyFor(defaultDesign(), { mujoco_version: "3.16.0" }), /trained on MuJoCo 3\.16\.0, the tab runs 3\.15\.0/],
  ];
  for (const [name, text, reason] of cases) {
    const [ok, note] = await staticTake(policyDir(text));
    assert.equal(ok, false, name);
    assert.match(note, /the tab would refuse it/, name);
    assert.match(note, reason, name);
  }
});

test("the MuJoCo it is checked against is the tab build's own: no versions.json in TAB_DIR is a failure", async () => {
  const [ok, note] = await staticTake(policyDir(await policyFor(defaultDesign())), mkdtempSync(join(tmpdir(), "home-policy-nobuild-")));
  assert.equal(ok, false);
  assert.match(note, /versions\.json/);
  const [okNoTab, noteNoTab] = await checkHomePolicy({ POLICY_DIR: policyDir(await policyFor(defaultDesign())) });
  assert.equal(okNoTab, false);
  assert.match(noteNoTab, /versions\.json in TAB_DIR/);
});

test("a policy the tab loads passes: for the start body, or for another preset the tab switches to", async () => {
  const [ok, note] = await staticTake(policyDir(await policyFor(defaultDesign())));
  assert.equal(ok, true, note);
  assert.match(note, /the body a fresh tab starts with, MuJoCo 3\.15\.0/);
  const [ok2, note2] = await staticTake(policyDir(await policyFor(PRESETS["quadruped 2-DOF"]!)));
  assert.equal(ok2, true, note2);
  assert.match(note2, /switches to the "quadruped 2-DOF" body/);
});

test("a live take skips the static file and needs the run link; the secret never reaches the note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "home-policy-link-"));
  const link = join(dir, "link");
  writeFileSync(link, "http://127.0.0.1:8899/run/r-1#s3cr3t-value\n");
  const [ok, note] = await checkHomePolicy({ SHOW_PIPE_LINK_FILE: link });
  assert.equal(ok, true, note);
  assert.match(note, /work\/home\/policy\.json/);
  assert.match(note, /http:\/\/127\.0\.0\.1:8899/);
  // A bad static file next to it changes nothing: in a live take the tab never fetches it.
  assert.equal((await checkHomePolicy({ SHOW_PIPE_LINK_FILE: link, POLICY_DIR: policyDir("{ nope") }))[0], true);

  const missing = await checkHomePolicy({ SHOW_PIPE_LINK_FILE: join(dir, "absent") });
  assert.equal(missing[0], false);
  assert.match(missing[1], /names no file/);
  writeFileSync(link, "http://127.0.0.1:8899/run/r-1\n");
  const noSecret = await checkHomePolicy({ SHOW_PIPE_LINK_FILE: link });
  assert.equal(noSecret[0], false);
  assert.match(noSecret[1], /does not hold a run link/);
  writeFileSync(link, "not a url s3cr3t-value");
  const garbage = await checkHomePolicy({ SHOW_PIPE_LINK_FILE: link });
  assert.equal(garbage[0], false);
  for (const n of [note, missing[1], noSecret[1], garbage[1]]) assert.doesNotMatch(n, /s3cr3t/);
});

test("the preflight runs this check, with its own environment, in place of the old shape check", () => {
  const src = readFileSync(fileURLToPath(new URL("../scripts/preflight.mjs", import.meta.url)), "utf8");
  assert.match(src, /import \{[^}]*\bcheckHomePolicy\b[^}]*\} from "\.\.\/home-policy\.ts"/);
  assert.match(src, /checkHomePolicy\(process\.env\)/);
  assert.doesNotMatch(src, /p\.format === "mlp-v1"/);
});
