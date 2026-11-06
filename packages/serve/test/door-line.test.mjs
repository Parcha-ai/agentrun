// A run's door, as its server learns it (door-line.ts): only the first line on its process's stdout is read, and the door
// it names is recorded only once it answers this launch's nonce. A forged first line is refused, a later door line is
// never read, and the nonce never reaches a tool's process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { doorProof } from "@parcha/pi-durable-disk/internals";
import { serveRun } from "../../pi-durable-disk/dist/serve.js";
import { firstDoorLine, verifyDoor } from "../dist/door-line.js";
import { follow, runDir, serve } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
const TOKEN = "door-token-for-the-test";
const headers = { authorization: `Bearer ${TOKEN}` };
const line = (serve, epoch = 3) => `${JSON.stringify({ event: "door", run: "r", epoch, pid: 1, serve })}\n`;

/** A real door (pi-durable-disk's), answering `nonce`; closed after the test. */
async function door(t, nonce) {
  const server = await serveRun({ port: 0, token: TOKEN, proof: nonce });
  t.after(() => server.close());
  return server.url;
}

/** A forger: an http server that answers POST /door-proof as if with `nonce` (which is not the launch's). */
async function forger(t, nonce) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => res.end(JSON.stringify({ proof: doorProof(nonce, JSON.parse(body || "{}").challenge ?? "") })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("a forged first door line is refused: the door it names does not answer the launch's nonce, and the real door's line after it is never read", async (t) => {
  const nonce = "a".repeat(64);
  const real = await door(t, nonce);
  const forged = await forger(t, "b".repeat(64));
  const stdout = new PassThrough();
  const first = firstDoorLine(stdout, 3);
  stdout.write(line(forged));
  stdout.write(line(real));
  const named = await first;
  assert.equal(named, forged, "the first line is the one read");
  assert.equal(await verifyDoor(named, nonce, headers), false, "the forged door does not answer the nonce: nothing is recorded");
  assert.equal(await verifyDoor(real, nonce, headers), true, "the real door does");
});

test("a door line after the first is never read: the verified first door stands", async (t) => {
  const nonce = "c".repeat(64);
  const real = await door(t, nonce);
  const forged = await forger(t, nonce);
  const stdout = new PassThrough();
  const first = firstDoorLine(stdout, 3);
  stdout.write(line(real));
  const named = await first;
  stdout.write(line(forged));
  stdout.write(line(forged, 4));
  stdout.end();
  assert.equal(named, real);
  assert.equal(await verifyDoor(named, nonce, headers), true);
});

test("a first line that is not a door line for this epoch names no door: another epoch, another scheme, text", async () => {
  for (const said of [line("http://127.0.0.1:9", 4), line("ftp://127.0.0.1:9"), "hello from a harness\n"]) {
    const stdout = new PassThrough();
    const first = firstDoorLine(stdout, 3);
    stdout.write(said);
    assert.equal(await first, undefined, said);
  }
});

test("through a run: the row's holder names the door its process proved, with the launch's nonce, which neither a tool's process (its environment, its descriptors) nor the run's own starting environment holds", { timeout: 120_000 }, async (t) => {
  if (process.platform !== "linux") return t.skip("reads /proc");
  const { api, data } = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX });
  const made = await api("POST", "/agents", { definition: { id: "env", name: "env", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/env/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "env > seen-env.txt; for f in /proc/$$/fd/*; do echo \"$(basename $f) $(readlink $f)\"; done > seen-fds.txt" } }] }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  let holder;
  for (let i = 0; !(holder?.door); i++) {
    assert.ok(i < 400, "the row names the door once proven");
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
    const claim = db.prepare("SELECT claim_holder FROM runs WHERE id = ?").get(run.body.run_id)?.claim_holder;
    db.close();
    holder = typeof claim === "string" && claim.startsWith("{") ? JSON.parse(claim) : undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(holder.nonce, /^[0-9a-f]{64}$/);
  // The descriptor the nonce came on, as the run's process was given it: open in no process the tool runs.
  const nonceFd = (() => {
    const args = readFileSync(`/proc/${holder.pid}/cmdline`, "utf8").split("\0");
    return args[args.indexOf("--door-nonce-fd") + 1];
  })();
  assert.match(nonceFd, /^\d+$/);
  // What any process of this user can read of the run's process: its starting environment.
  if (process.platform === "linux") assert.ok(!readFileSync(`/proc/${holder.pid}/environ`, "utf8").includes(holder.nonce), "not in the run's starting environment");
  assert.equal(await verifyDoor(holder.door, holder.nonce, { authorization: `Bearer ${readFileSync(join(runDir(data, run.body.run_id), "door-token"), "utf8").trim()}` }), true);
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  const fds = readFileSync(join(runDir(data, run.body.run_id), "work", "seen-fds.txt"), "utf8").trim().split("\n");
  assert.ok(fds.length >= 3, `the tool listed its descriptors: ${fds.join(", ")}`);
  assert.deepEqual(fds.filter((line) => line.startsWith(`${nonceFd} `)), [], `the tool's process has no descriptor ${nonceFd}: ${fds.join(", ")}`);
  const seen = readFileSync(join(runDir(data, run.body.run_id), "work", "seen-env.txt"), "utf8");
  assert.ok(seen.length > 0, "the tool ran");
  assert.ok(!seen.includes("PI_DURABLE_DISK_DOOR_NONCE") && !seen.includes(holder.nonce), "the tool's process has no nonce");
});
