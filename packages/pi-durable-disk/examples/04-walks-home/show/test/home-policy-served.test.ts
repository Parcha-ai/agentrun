import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkServedHomePolicy } from "../home-policy.ts";
import { dummyPolicy } from "../../tab/src/dummy.ts";
import { defaultDesign } from "../../tab/src/design.ts";
import { buildMjcf } from "../../tab/src/mjcf.ts";
import { sha256Hex } from "../../tab/src/policy.ts";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { freePort, waitForStage } from "../scripts/cdp.mjs";

// The preflight's probe of a running stage (SHOW_URL): what that stage serves the home beat, through the tab's own code. It
// closes the gap where the preflight's environment and the stage's differ (a stage started without POLICY_DIR, or with another).
const MUJOCO = "3.15.0";
async function policy(patch: Record<string, unknown> = {}): Promise<string> {
  const built = buildMjcf(defaultDesign());
  const file = dummyPolicy({ mjcfSha256: await sha256Hex(built.xml), mujocoVersion: MUJOCO, nj: built.jointNames.length, jointsPerLeg: built.jointsPerLeg });
  return JSON.stringify({ ...file, ...patch });
}

const servers: Server[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const c of children) c.kill();
});
/** A stand-in stage: routes to bodies (404 for anything else), and every path it was asked for. */
async function fakeStage(routes: Record<string, string>): Promise<{ origin: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? "");
    const body = routes[req.url ?? ""];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked };
}
const STATE = JSON.stringify({ run: "walks-home-demo", environments: [], place: { where: "tab" } });
const stage = (feed: string, tab: string) => JSON.stringify({ feed, tab });
const VERSIONS = JSON.stringify({ mujoco: MUJOCO });

test("a server that is not a stage is refused before anything is read from it", async () => {
  const s = await fakeStage({ "/policy/home.json": await policy() });
  const [ok, note] = await checkServedHomePolicy(s.origin);
  assert.equal(ok, false);
  assert.match(note, /not a stage/);
  assert.ok(!s.asked.includes("/policy/home.json"));
});

test("a stage that cannot say what it serves (started before /api/stage) is a failure that says to restart it", async () => {
  const s = await fakeStage({ "/api/state": STATE, "/policy/home.json": await policy(), "/tab/versions.json": VERSIONS });
  const [ok, note] = await checkServedHomePolicy(s.origin);
  assert.equal(ok, false);
  assert.match(note, /\/api\/stage/);
  assert.match(note, /restart/);
});

test("a pipe-fed stage passes without asking for the static file: its tab reads the run's own work/home/policy.json", async () => {
  const s = await fakeStage({ "/api/state": STATE, "/api/stage": stage("pipe", "app") });
  const [ok, note] = await checkServedHomePolicy(s.origin);
  assert.equal(ok, true, note);
  assert.match(note, /work\/home\/policy\.json/);
  assert.ok(!s.asked.includes("/policy/home.json"));
});

test("a stage serving the stub tab fails, whatever its feed: the stub loads no policy, static or from the run's disk", async () => {
  for (const feed of ["scripted", "pipe", "upstream"]) {
    const s = await fakeStage({ "/api/state": STATE, "/api/stage": stage(feed, "stub"), "/policy/home.json": await policy() });
    const [ok, note] = await checkServedHomePolicy(s.origin);
    assert.equal(ok, false, feed);
    assert.match(note, /stub tab/, feed);
  }
});

test("a stage that serves no home.json fails with the caption the camera would see", async () => {
  const s = await fakeStage({ "/api/state": STATE, "/api/stage": stage("scripted", "app"), "/tab/versions.json": VERSIONS });
  const [ok, note] = await checkServedHomePolicy(s.origin);
  assert.equal(ok, false);
  assert.match(note, /could not fetch \/policy\/home\.json: HTTP 404/);
});

test("a served policy the tab's own code refuses fails with the tab's reason, checked against the MuJoCo the stage's tab ships", async () => {
  const refused = await fakeStage({ "/api/state": STATE, "/api/stage": stage("upstream", "app"), "/tab/versions.json": VERSIONS, "/policy/home.json": await policy({ control_dt: 0.05 }) });
  const [ok, note] = await checkServedHomePolicy(refused.origin);
  assert.equal(ok, false);
  assert.match(note, /the tab would refuse it: control_dt 0\.05/);
  const otherMujoco = await fakeStage({ "/api/state": STATE, "/api/stage": stage("scripted", "app"), "/tab/versions.json": JSON.stringify({ mujoco: "3.16.0" }), "/policy/home.json": await policy() });
  const [ok2, note2] = await checkServedHomePolicy(otherMujoco.origin);
  assert.equal(ok2, false);
  assert.match(note2, /trained on MuJoCo 3\.15\.0, the tab runs 3\.16\.0/);
});

test("a served policy the tab loads passes, and the note says it was the running stage's", async () => {
  const s = await fakeStage({ "/api/state": STATE, "/api/stage": stage("scripted", "app"), "/tab/versions.json": VERSIONS, "/policy/home.json": await policy() });
  const [ok, note] = await checkServedHomePolicy(`${s.origin}/`);
  assert.equal(ok, true, note);
  assert.match(note, /served by the stage: the tab loads it, the body a fresh tab starts with, MuJoCo 3\.15\.0/);
});

// The real stage, three ways: the probe and serve.ts agree on /api/stage, and a stage started without the winner's policy fails.
async function realStage(env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../serve.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, SHOW_PORT: String(port), SHOW_AUTOKILL: "off", ...env },
    stdio: "ignore",
  });
  children.push(child);
  await waitForStage(port, child);
  return `http://127.0.0.1:${port}`;
}
test("against the real serve.ts: no policy fails, the winner's passes, a pipe feed is a live take, the stub tab fails on either feed", async () => {
  const tab = mkdtempSync(join(tmpdir(), "served-tab-"));
  writeFileSync(join(tab, "versions.json"), VERSIONS);
  const empty = mkdtempSync(join(tmpdir(), "served-nopolicy-"));
  const withPolicy = mkdtempSync(join(tmpdir(), "served-policy-"));
  writeFileSync(join(withPolicy, "home.json"), await policy());

  const [okNone, noteNone] = await checkServedHomePolicy(await realStage({ TAB_DIR: tab, POLICY_DIR: empty }));
  assert.equal(okNone, false);
  assert.match(noteNone, /HTTP 404/);
  const [okWinner, noteWinner] = await checkServedHomePolicy(await realStage({ TAB_DIR: tab, POLICY_DIR: withPolicy }));
  assert.equal(okWinner, true, noteWinner);
  const [okStub, noteStub] = await checkServedHomePolicy(await realStage({ POLICY_DIR: withPolicy }));
  assert.equal(okStub, false);
  assert.match(noteStub, /stub tab/);
  // A link file that is not there yet: the stage starts anyway and follows it, and it is a pipe feed from the start.
  const [okPipe, notePipe] = await checkServedHomePolicy(await realStage({ TAB_DIR: tab, SHOW_PIPE_LINK_FILE: join(empty, "link") }));
  assert.equal(okPipe, true, notePipe);
  assert.match(notePipe, /pipe/);
  const [okPipeStub, notePipeStub] = await checkServedHomePolicy(await realStage({ SHOW_PIPE_LINK_FILE: join(empty, "link") }));
  assert.equal(okPipeStub, false);
  assert.match(notePipeStub, /stub tab/);
});

test("with SHOW_URL the preflight probes the running stage instead of reading its own environment", () => {
  const src = readFileSync(fileURLToPath(new URL("../scripts/preflight.mjs", import.meta.url)), "utf8");
  assert.match(src, /import \{ checkHomePolicy, checkServedHomePolicy \} from "\.\.\/home-policy\.ts"/);
  assert.match(src, /showUrl \? checkServedHomePolicy\(showUrl\) : checkHomePolicy\(process\.env\)/);
});
