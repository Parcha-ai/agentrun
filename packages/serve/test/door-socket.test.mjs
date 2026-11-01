// A run's door on a unix socket in its own directory (`doorSocket`): the run runs through it to completion on the faux
// model and its timeline streams from it; serve dials a socket only inside the run's own directory; a socket path too long
// for a socket address keeps the run on loopback, said in the log. Off by default: a run serves its door on loopback.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { SOCKET_PATH_MAX } from "@parcha/pi-durable-disk";
import { socketIn } from "../dist/runs.js";
import { follow, serve, startRun } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RUN_ID = "x".repeat(36);

/** A data directory whose runs' sockets fit a socket address: under TMPDIR when that is short enough, else /tmp. */
async function shortData(t) {
  const fits = (base) => Buffer.byteLength(join(base, "agentrun-serve-XXXXXX", "agents", "runs", RUN_ID, "door.sock")) <= SOCKET_PATH_MAX;
  const base = [process.env.TMPDIR ?? tmpdir(), "/tmp"].find(fits) ?? "/tmp";
  const dir = await mkdtemp(join(base, "agentrun-serve-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "agents");
}

/** A listening socket at `path`, closed after test `t`; `reached` lists every request it was sent. */
async function listening(t, path) {
  const reached = [];
  const server = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return reached;
}

const record = async (data, runId) => JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));

async function gone(pid) {
  for (let i = 0; processAlive(pid); i++) {
    assert.ok(i < 600, `the run's process ${pid} exits`);
    await sleep(50);
  }
}

test("a run launched with doorSocket serves its door on a 0600 socket in its directory: it waits, is answered through it, completes, and its timeline streams", async (t) => {
  const data = await shortData(t);
  const { api } = await serve(t, { data, doorSocket: true });
  const { run_id } = await startRun(api, "regions", "Pick a region.", { tools: ["ask_person"] });
  const socket = join(data, "runs", run_id, "door.sock");
  const waiting = await follow(api, run_id, ["input_required"]);
  // The run's process is alive and waiting: these rows came from its door's event stream, over the socket.
  const live = await record(data, run_id);
  assert.deepEqual([live.status, live.holder.serve, processAlive(live.holder.pid)], ["running", `unix:${socket}`, true]);
  assert.ok(lstatSync(socket).isSocket());
  assert.equal((lstatSync(socket).mode & 0o777).toString(8), "600");
  assert.equal(waiting.rows.find((r) => r.kind === "waiting")?.summary, "Waiting for you: Which region should I use?");
  const answered = await api("POST", `/runs/${run_id}/messages`, { content: "eu-west" });
  assert.equal(answered.status, 202, JSON.stringify(answered.body));
  assert.equal(answered.body.mode, "answer");
  const { rows, last } = await follow(api, run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["Pick a region.", "eu-west"]);
  assert.ok(rows.some((r) => r.kind === "final_answer"), rows.map((r) => r.kind).join(", "));
  await gone(live.holder.pid);
  assert.equal(existsSync(socket), false, "the run's process removed its socket as it exited");
});

test("the default launch is unchanged: a run serves its door on loopback, and its directory holds no socket", async (t) => {
  const { api, data } = await serve(t);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  const { last } = await follow(api, run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.match((await record(data, run_id)).holder.serve, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(existsSync(join(data, "runs", run_id, "door.sock")), false);
});

test("serve takes a run's unix door only inside the run's own directory: never with ../, elsewhere, through a link, or not a socket", async (t) => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-door-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, "runs");
  const dir = join(runs, "run-1");
  const other = join(root, "other");
  mkdirSync(join(dir, "sub"), { recursive: true });
  mkdirSync(other);
  await listening(t, join(dir, "door.sock"));
  await listening(t, join(dir, "sub", "door.sock"));
  await listening(t, join(other, "door.sock"));
  symlinkSync(join(other, "door.sock"), join(dir, "link.sock"));
  symlinkSync(other, join(dir, "linked"));
  mkdirSync(`${dir}x`);
  await listening(t, join(`${dir}x`, "door.sock"));
  writeFileSync(join(dir, "file.sock"), "");
  symlinkSync(runs, join(root, "runs-link"));

  assert.equal(socketIn(dir, join(dir, "door.sock")), join(dir, "door.sock"), "its own socket");
  assert.equal(socketIn(dir, join(dir, "sub", "door.sock")), join(dir, "sub", "door.sock"), "a socket in a real directory below it");
  assert.equal(socketIn(join(root, "runs-link", "run-1"), join(root, "runs-link", "run-1", "door.sock")), join(root, "runs-link", "run-1", "door.sock"), "a run directory reached through a link of its own");
  for (const [path, why] of [
    ["../other/door.sock", "a relative path"],
    [`${dir}/../../other/door.sock`, "a path with .."],
    [`${dir}/./door.sock`, "a path with ."],
    [`${dir}//door.sock`, "a path with an empty part"],
    [join(other, "door.sock"), "an absolute path elsewhere"],
    [join(`${dir}x`, "door.sock"), "a directory whose name starts with the run's"],
    [join(dir, "link.sock"), "a link to a socket elsewhere"],
    [join(dir, "linked", "door.sock"), "a socket reached through a linked directory"],
    [join(dir, "file.sock"), "a file that is not a socket"],
    [join(dir, "gone.sock"), "nothing there"],
    [dir, "the run's directory itself"],
  ]) assert.equal(socketIn(dir, path), undefined, why);
});

test("a live run whose run.json points its door elsewhere is never dialled there: ../, an absolute path and a link are refused, its own socket answers", { timeout: 120_000 }, async (t) => {
  const data = await shortData(t);
  const { api } = await serve(t, { data, doorSocket: true, readyTimeoutMs: 1_000 });
  const { run_id } = await startRun(api, "regions", "Pick a region.", { tools: ["ask_person"] });
  await follow(api, run_id, ["input_required"]);
  const dir = join(data, "runs", run_id);
  const file = join(dir, "run.json");
  const kept = await readFile(file, "utf8");
  const live = JSON.parse(kept);
  assert.equal(live.holder.serve, `unix:${join(dir, "door.sock")}`);
  // A door elsewhere that answers anything, and a link to it in the run's directory: serve must never reach it.
  mkdirSync(join(data, "elsewhere"));
  const decoy = join(data, "elsewhere", "door.sock");
  const reached = await listening(t, decoy);
  symlinkSync(decoy, join(dir, "link.sock"));
  // The run's process holds still, so no heartbeat of its own writes its door back while another is in its run.json.
  process.kill(live.holder.pid, "SIGSTOP");
  t.after(() => processAlive(live.holder.pid) && process.kill(live.holder.pid, "SIGCONT"));
  const write = async (text) => {
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
  };
  for (const serveAt of [`unix:${dir}/../../elsewhere/door.sock`, "unix:../elsewhere/door.sock", `unix:${decoy}`, `unix:${join(dir, "link.sock")}`]) {
    await write(JSON.stringify({ ...live, heartbeatAt: new Date().toISOString(), holder: { ...live.holder, serve: serveAt } }));
    const refused = await api("POST", `/runs/${run_id}/messages`, { content: "eu-west" });
    assert.equal(refused.status, 503, `${serveAt}: ${JSON.stringify(refused.body)}`);
  }
  assert.deepEqual(reached, [], "nothing was sent to the socket elsewhere");
  await write(kept);
  process.kill(live.holder.pid, "SIGCONT");
  const answered = await api("POST", `/runs/${run_id}/messages`, { content: "eu-west" });
  assert.equal(answered.status, 202, JSON.stringify(answered.body));
  const { last } = await follow(api, run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.deepEqual(reached, []);
});

test("a data directory too deep for a socket address keeps the run on loopback, says so in the log, and the run completes", async (t) => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const data = join(scratch, "d".repeat(SOCKET_PATH_MAX), "agents");
  const lines = [];
  const { api } = await serve(t, { data, doorSocket: true, log: (line) => lines.push(line) });
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  const { last } = await follow(api, run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.status, "completed");
  assert.match((await record(data, run_id)).holder.serve, /^http:\/\/127\.0\.0\.1:\d+$/);
  const said = lines.find((line) => line.includes("event=door_socket_too_long"));
  assert.ok(said, lines.join("\n"));
  assert.match(said, new RegExp(`run=${run_id} bytes=\\d+ limit=${SOCKET_PATH_MAX} serves_on=loopback`));
  assert.equal(existsSync(join(data, "runs", run_id, "door.sock")), false);
});
