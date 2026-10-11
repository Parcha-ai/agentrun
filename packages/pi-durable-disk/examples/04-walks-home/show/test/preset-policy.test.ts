import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkServedHomePolicy } from "../home-policy.ts";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { freePort, waitForStage } from "../scripts/cdp.mjs";

// The rehearsal stage serves a walking brain for the tab's own quadruped when POLICY_DIR is not set, so a fresh checkout's home beat (and v2-check) works without any file from
// a run. The file is a fixture: a real trained brain (mlp-v1, MuJoCo 3.15.0), pinned by its hash. A live day still has to say where the winner's policy is.
const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(show, "fixtures", "preset-quadruped", "home.json");
const SHA256 = "90ac5a9abec104ad0fc243553eb02508af83dde32d6a3025da2fd03718cd1a2f";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));
async function realStage(env: Record<string, string>): Promise<string> {
  const port = await freePort();
  // A small explicit environment, so a developer's shell (SHOW_PIPE_LINK_FILE, POLICY_DIR, TAB_DIR) cannot change which stage this is.
  const child = spawn(process.execPath, [join(show, "serve.ts")], { env: { PATH: process.env.PATH, SHOW_PORT: String(port), SHOW_AUTOKILL: "off", ...env }, stdio: "ignore" });
  children.push(child);
  await waitForStage(port, child);
  return `http://127.0.0.1:${port}`;
}
const tabDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "preset-tab-"));
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ mujoco: "3.15.0" }));
  return dir;
};

test("the preset's file is the one that was pinned, and says what it is", () => {
  const bytes = readFileSync(FIXTURE);
  assert.equal(sha(bytes), SHA256);
  const file = JSON.parse(bytes.toString("utf8"));
  assert.equal(file.format, "mlp-v1");
  assert.equal(file.mujoco_version, "3.15.0");
  assert.equal(typeof file.mjcf_sha256, "string");
  assert.ok(Array.isArray(file.layers) && file.layers.length > 0);
});

test("the preset holds no machine path, user, hostname or address", () => {
  const text = readFileSync(FIXTURE, "utf8");
  for (const bad of [/\/home\//, /\/Users\//, /\/tmp\//, /\/run\//, /ubuntu/i, /ns\d{6,}/, /tailscale/i, /https?:\/\//, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.sock\b/]) {
    assert.equal(bad.test(text), false, `matched ${bad}`);
  }
});

test("a stage with no POLICY_DIR serves the preset's bytes; with POLICY_DIR it serves that folder's file", async () => {
  const base = await realStage({});
  const served = Buffer.from(await (await fetch(`${base}/policy/home.json`)).arrayBuffer());
  assert.equal(sha(served), SHA256);
  assert.equal(((await (await fetch(`${base}/api/stage`)).json()) as { policy: string }).policy, "preset");

  const dir = mkdtempSync(join(tmpdir(), "preset-own-"));
  writeFileSync(join(dir, "home.json"), "{}");
  const own = await realStage({ POLICY_DIR: dir });
  assert.equal(await (await fetch(`${own}/policy/home.json`)).text(), "{}");
  assert.equal(((await (await fetch(`${own}/api/stage`)).json()) as { policy: string }).policy, "dir");
});

test("the tab loads the preset (its body is a fresh tab's), and the preflight still refuses a stage that serves it in place of the winner's policy", async () => {
  const tab = tabDir();
  // The preset as a POLICY_DIR the operator chose: the tab's own planArrival and Policy.load accept it.
  const chosen = await realStage({ TAB_DIR: tab, POLICY_DIR: dirname(FIXTURE) });
  const [okChosen, noteChosen] = await checkServedHomePolicy(chosen);
  assert.equal(okChosen, true, noteChosen);
  assert.match(noteChosen, /the tab loads it, the body a fresh tab starts with, MuJoCo 3\.15\.0/);
  // The same bytes served as the built-in default: fine for a rehearsal, never for the live day, which has to name the winner's policy.
  const preset = await realStage({ TAB_DIR: tab });
  const [okPreset, notePreset] = await checkServedHomePolicy(preset);
  assert.equal(okPreset, false);
  assert.match(notePreset, /rehearsal preset/);
  assert.match(notePreset, /POLICY_DIR/);
});

test("a developer's shell settings do not change which stage the test starts", async () => {
  const saved = { link: process.env.SHOW_PIPE_LINK_FILE, dir: process.env.POLICY_DIR };
  process.env.SHOW_PIPE_LINK_FILE = join(tmpdir(), "no-such-link");
  process.env.POLICY_DIR = tmpdir();
  try {
    const base = await realStage({});
    const info = (await (await fetch(`${base}/api/stage`)).json()) as { feed: string; policy: string };
    assert.deepEqual({ feed: info.feed, policy: info.policy }, { feed: "scripted", policy: "preset" });
  } finally {
    if (saved.link === undefined) delete process.env.SHOW_PIPE_LINK_FILE;
    else process.env.SHOW_PIPE_LINK_FILE = saved.link;
    if (saved.dir === undefined) delete process.env.POLICY_DIR;
    else process.env.POLICY_DIR = saved.dir;
  }
});
