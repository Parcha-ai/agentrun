// image-custody.sh's check, run inside the container (`docker exec -i ... node --input-type=module -`), as the server's
// user: one agent on the faux model (image-custody-faux.mjs), then
//   - a run that reports what its process holds and reaches, and the status the helper left it (its uid, its groups, its
//     capabilities, no_new_privs);
//   - two live runs at once: one holding its turn (the beacon: a file in its folder, a program in a session of its own),
//     the other reaching for it (its folder, its file, its process's environment, memory and descriptors, and a socket of
//     the group the container gives the server's user, as compose gives it the Docker socket's);
//   - the data directory walked as a slot's uid while the beacon is live: nothing in it listed or read;
//   - the beacon's end: its process, the program it left in a session of its own and its file in /tmp gone, and the next
//     run on its slot (the same uid) reaching nothing it left;
//   - a run started with an upload (file_ids) reading it in its work folder, and a run's next message writing beside the
//     folders the server's user left deep in its work folder;
//   - a run holding its turn while every process is read for a secret.
// Every failure is said, one line each, and the check exits 1 after the last.
// Its environment: CANARY (the prefix of every canary but the seal key's), SEAL (the seal key's canary; empty, the key in
// seal/seal.key is one), TOKEN (the API token), SOCKET_GID (the group the container gives the server's user, the Docker
// socket's stand-in).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const failed = [];
const fail = (why) => void failed.push(why);
const stop = (why) => {
  for (const each of failed) console.error(`image custody: FAIL ${each}`);
  console.error(`image custody: FAIL ${why}`);
  process.exit(1);
};
const base = "http://127.0.0.1:7340/v2"; // key-gate: loopback-rule the check reaches the server inside its own container, on loopback only
const api = (method, path, body) => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HELPER = "/usr/local/bin/agentrun-runas";
const FIRST_RUN_ID = 1001;
const SLOTS = 256;
const BEACON = "/tmp/image-custody-beacon.json";
const SOCKET = "/tmp/image-custody-socket";
const alive = (pid) => existsSync(`/proc/${pid}`) && !/^State:\s+Z/m.test((() => {
  try {
    return readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return "";
  }
})());

for (let i = 0; ; i++) {
  if ((await fetch(`${base}/health`).then((r) => r.status, () => 0)) === 200) break;
  if (i > 600) stop("the server never answered /v2/health");
  await sleep(200);
}
const capabilities = (await api("GET", "/capabilities")).body;
if (capabilities?.run_isolation !== "uid") fail(`the capabilities say run_isolation ${JSON.stringify(capabilities?.run_isolation)}, not "uid"`);
// On an OpenAI model (the faux model answers): OpenAI's key is the one key its run's process needs.
const made = await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: [], model: "openai/gpt-6.1-sol" } });
if (made.status !== 201) stop(`the agent was not made (${made.status} ${JSON.stringify(made.body)})`);
const start = async (content) => (await api("POST", "/agents/custody/runs", { input: { content } })).body;
const finished = async (run) => {
  let view;
  for (let i = 0; (view = (await api("GET", `/runs/${run.run_id}`)).body).status !== "completed"; i++) {
    if (i > 600 || view?.status === "failed") stop(`the run did not complete: ${JSON.stringify(view)}`);
    await sleep(200);
  }
  return JSON.parse(view.result.final_answer);
};
/** Run `runId`'s answer once it names `key` ({answer}), or what its failure said ({failed}); never a stop, so the checks
 *  after it still run. */
const answered = async (runId, key) => {
  for (let i = 0; ; i++) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (view?.status === "failed") return { failed: JSON.stringify(view.result ?? view.error ?? view).slice(0, 400) };
    try {
      const answer = JSON.parse(view?.result?.final_answer ?? "null");
      if (answer && key in answer) return { answer };
    } catch {}
    if (i > 600) return { failed: `no answer naming ${key}: ${JSON.stringify(view).slice(0, 400)}` };
    await sleep(200);
  }
};

/** What the helper left a run's process (or a program it starts) as its /proc/self/status says: its slot's uid and gid in
 *  every field, that group alone, every capability set empty, no_new_privs set. */
const checkStatus = (who, seen) => {
  const { uid, status } = seen;
  if (!(uid >= FIRST_RUN_ID && uid < FIRST_RUN_ID + SLOTS)) fail(`${who} runs as uid ${uid}, not a slot's (${FIRST_RUN_ID}-${FIRST_RUN_ID + SLOTS - 1})`);
  if (status.Uid.join() !== [uid, uid, uid, uid].join()) fail(`${who}'s uids are ${status.Uid.join(" ")}, not ${uid} in each`);
  if (status.Gid.join() !== [uid, uid, uid, uid].join()) fail(`${who}'s gids are ${status.Gid.join(" ")}, not ${uid} in each`);
  if (status.Groups.join() !== String(uid)) fail(`${who}'s groups are [${status.Groups.join(" ")}], not its slot's group alone`);
  for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    if (status[set].length !== 1 || BigInt(`0x${status[set][0]}`) !== 0n) fail(`${who}'s ${set} is ${status[set].join(" ")}, not empty`);
  }
  if (status.NoNewPrivs.join() !== "1") fail(`${who} has no_new_privs ${status.NoNewPrivs.join(" ") || "unset"}, not 1`);
};

// 1. A run's report.
const run = await start("Report.");
const report = await finished(run);
const held = Object.entries(report.handed).filter(([, has]) => has).map(([name]) => name);
console.log(`REPORT handed=${held.join(",")} inEnv=${report.inEnv.join(",")}`);
console.log(`REPORT dataOwner=${report.dataOwner} run=${JSON.stringify(report.run)} child=${JSON.stringify(report.child)}`);
if (!held.includes("OPENAI_API_KEY")) fail("the run's process was not handed its model key");
if (held.join() !== "OPENAI_API_KEY") fail(`the run's process was handed ${held.join(", ")}, not its model's key alone`);
if (report.inEnv.length) fail(`the run's process has ${report.inEnv.join(", ")} in its environment`);
for (const [who, seen] of [["the run's process", report.run], ["a program the run starts", report.child]]) {
  if (seen.error) {
    fail(`${who}: ${seen.error}`);
    continue;
  }
  if (seen.uid === report.dataOwner) fail(`${who} runs as uid ${seen.uid}, the server's own, which owns the data directory`);
  checkStatus(who, seen);
  if (seen.listed) fail(`${who} lists the data directory`);
  const read = Object.entries(seen.files).filter(([, how]) => how === "read").map(([name]) => name);
  if (read.length) fail(`${who} reads ${read.join(", ")}`);
  if (seen.memory.length) fail(`${who} opens the memory of ${seen.memory.join("; ")}`);
}

// 2. Two live runs. A socket of the group the container gives this user (compose's Docker socket group): this user
// connects to it, a run's process must not.
const socketGid = Number(process.env.SOCKET_GID);
if (!process.getgroups().includes(socketGid)) fail(`the server's user is not in group ${socketGid}, the socket's: the container was not given it, so the socket check proves nothing`);
rmSync(SOCKET, { force: true });
const server = createServer((socket) => socket.destroy());
await new Promise((resolve, reject) => server.once("error", reject).listen(SOCKET, resolve));
chownSync(SOCKET, process.getuid(), socketGid);
chmodSync(SOCKET, 0o660);
rmSync(BEACON, { force: true });
const beaconRun = await start("Beacon.");
let beacon;
for (let i = 0; !beacon; i++) {
  try {
    beacon = JSON.parse(readFileSync(BEACON, "utf8"));
  } catch {
    if (i > 300) stop("the beacon run never wrote its beacon");
    await sleep(100);
  }
}
// The server's user reads the beacon's folder through its slot's group: the file is there to be reached for.
try {
  readFileSync(join(beacon.tmp, "beacon"));
} catch (error) {
  fail(`the server's user cannot read the beacon run's file (${error.code}): the reach below proves nothing`);
}
if (!alive(beacon.started)) fail("the program the beacon run started in a session of its own is not running");
const reacher = await start(`Reach ${JSON.stringify({ ...beacon, socket: SOCKET })}`);
const reached = await finished(reacher);
console.log(`REACH beacon uid=${beacon.uid} reacher=${JSON.stringify(reached)}`);
for (const [who, seen] of [["a live run's process", reached.run], ["a program a live run starts", reached.child]]) {
  if (seen.error) {
    fail(`${who}: ${seen.error}`);
    continue;
  }
  if (seen.uid === beacon.uid) fail(`${who} runs as uid ${seen.uid}, the other live run's own`);
  checkStatus(who, seen);
  for (const [what, how] of Object.entries(seen).filter(([name]) => !["uid", "status"].includes(name))) {
    if (how === "read") fail(`${who} reaches the other live run's ${what}`);
    if (how === "absent" && what !== "dockerSocket") fail(`${who} found no ${what} of the other live run: the reach proves nothing`);
  }
}

// 3. The data directory walked as a slot's uid (the last, which no runner here holds), the beacon run live: every entry
// the server's user lists, none of it listed or read by a run's uid, but the harnesses its runs execute.
const entries = [{ path: "/data", dir: true }];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    entries.push({ path, dir: stat.isDirectory() });
    if (stat.isDirectory() && !path.startsWith("/data/harnesses")) walk(path);
  }
};
walk("/data");
const walker = `
  const { closeSync, openSync, readdirSync, readFileSync, readSync } = await import("node:fs");
  const reached = [];
  for (const { path, dir } of JSON.parse(readFileSync(0, "utf8"))) {
    try {
      if (dir) readdirSync(path);
      else {
        const fd = openSync(path, "r");
        try { readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { closeSync(fd); }
      }
      reached.push(path);
    } catch {}
  }
  process.stdout.write(JSON.stringify({ uid: process.getuid(), reached }));`;
const walked = spawnSync(HELPER, ["run", String(SLOTS - 1), "--", process.execPath, "--input-type=module", "-e", walker], { input: JSON.stringify(entries), encoding: "utf8" });
let walkedOut;
try {
  walkedOut = JSON.parse(walked.stdout);
} catch {
  fail(`the walk as slot ${SLOTS - 1} did not answer (exit ${walked.status}): ${(walked.stderr ?? "").slice(0, 300)}`);
}
if (walkedOut) {
  if (walkedOut.uid !== FIRST_RUN_ID + SLOTS - 1) fail(`the walk ran as uid ${walkedOut.uid}, not slot ${SLOTS - 1}'s`);
  const reachedData = walkedOut.reached.filter((path) => !path.startsWith("/data/harnesses"));
  if (reachedData.length) fail(`a slot's uid reaches ${reachedData.length} entries of the data directory: ${reachedData.slice(0, 12).join(", ")}`);
  // What the walk must have met for it to prove anything: the server's own record (.server.json, written once it
  // listens, in either shape) and, on a SQLite store, the store's file (a Postgres store keeps nothing in /data).
  const anchors = [".server.json", ...(process.env.STORE_KIND === "postgres" ? [] : ["store.sqlite"])];
  for (const anchor of anchors) if (!entries.some(({ path }) => path.endsWith(`/${anchor}`))) fail(`the walk found no ${anchor}: it proves nothing`);
}

// 4. The beacon run's end: every process of its uid gone (the one in a session of its own too), its file in /tmp and its
// scratch folder swept (the runner's to remove, as the folder above it is the server's), and the next run, on the same
// slot, reaching nothing it left.
const agentDir = `custody-${createHash("sha256").update("custody", "utf8").digest("hex").slice(0, 16)}`;
const beaconScratch = `/data/scratch/${agentDir}/${beaconRun.run_id}`;
await api("POST", `/runs/${beaconRun.run_id}/cancel`);
for (let i = 0; alive(beacon.pid) || alive(beacon.started) || existsSync(BEACON) || existsSync(beaconScratch); i++) {
  if (i > 300) {
    if (alive(beacon.pid)) fail("the cancelled run's process is still running");
    if (alive(beacon.started)) fail("the program the cancelled run started in a session of its own is still running");
    if (existsSync(BEACON)) fail("the cancelled run's file in /tmp is still there");
    if (existsSync(beaconScratch)) fail(`the cancelled run's scratch folder is still there: ${(() => { try { return readdirSync(beaconScratch).join(", ") || "empty"; } catch (error) { return error.code; } })()}`);
    break;
  }
  await sleep(100);
}
const next = await finished(await start(`Reach ${JSON.stringify({ ...beacon, socket: SOCKET })}`));
console.log(`REUSE beacon uid=${beacon.uid} next=${JSON.stringify(next)}`);
if (next.run.uid !== beacon.uid) fail(`the next run ran as uid ${next.run.uid}, not the ended run's ${beacon.uid}: the slot's reuse was not tried`);
for (const [who, seen] of [["the slot's next run", next.run], ["a program the slot's next run starts", next.child]]) {
  if (seen.error) {
    fail(`${who}: ${seen.error}`);
    continue;
  }
  for (const what of ["folder", "file"]) if (seen[what] === "read") fail(`${who} reaches the ended run's ${what}`);
}
server.close();
rmSync(SOCKET, { force: true });

// 4b. A run started with an upload (file_ids) reads it in its work folder: the runner places it there before the run's
// process starts, as the upload's hold is the server's alone.
const uploaded = await fetch(`${base}/files?path=custody/notes.txt`, { method: "POST", headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "text/plain" }, body: "custody upload\n" }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
if (uploaded.status !== 201) stop(`the upload was not taken (${uploaded.status} ${JSON.stringify(uploaded.body)})`);
const inputsRun = (await api("POST", "/agents/custody/runs", { input: { content: "Inputs." }, file_ids: [uploaded.body.file.file_id] })).body;
const inputs = await answered(inputsRun.run_id, "inputs");
console.log(`INPUTS ${JSON.stringify(inputs)}`);
if (inputs.failed) fail(`a run started with an upload did not complete: ${inputs.failed}`);
else if (inputs.answer.inputs !== "custody upload\n") fail(`a run started with an upload read ${JSON.stringify(inputs.answer.inputs)} at inputs/custody/notes.txt, not the upload`);

// 4c. What the server's user left deep in a run's work folder (a volume from before runs had a uid of their own), the
// run's to write beside in its next message.
const work = `/data/disk/agents/${agentDir}/runs/${run.run_id}/work`;
mkdirSync(`${work}/old/deep`, { recursive: true });
for (const dir of [`${work}/old`, `${work}/old/deep`]) chmodSync(dir, 0o755);
writeFileSync(`${work}/old/deep/before.txt`, "before\n", { mode: 0o644 });
await api("POST", `/runs/${run.run_id}/messages`, { content: "Deep." });
const deep = await answered(run.run_id, "deep");
console.log(`DEEP ${JSON.stringify(deep)}`);
if (deep.failed) fail(`a run's next message did not complete: ${deep.failed}`);
else if (deep.answer.deep !== "written") fail(`a run's next message could not write beside the folders the server's user left deep in its work folder: ${deep.answer.deep}`);

// 5. A turn held open, so every process that holds anything only while a turn goes is there to be read.
await api("POST", `/runs/${run.run_id}/messages`, { content: "Hold." });
for (let i = 0; (await api("GET", `/runs/${run.run_id}`)).body.state !== "working"; i++) {
  if (i > 300) stop("the held turn never worked");
  await sleep(100);
}
// The held turn's process is up (a process of a slot's uid) before anything is read: a run that is working may not have
// it yet, and a scan before it reads none of what it holds.
const slotUid = (pid) => {
  try {
    const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
    return uid >= FIRST_RUN_ID && uid < FIRST_RUN_ID + SLOTS;
  } catch {
    return false;
  }
};
for (let i = 0; !readdirSync("/proc").some((p) => /^\d+$/.test(p) && slotUid(p)); i++) {
  if (i > 300) stop("the held turn's process never started: a scan without it reads nothing of a turn");
  await sleep(100);
}
await sleep(500);
// With no seal key handed (--seal-file), the one the server made in the data directory is a canary too: this check runs
// as the server's uid, which reads it.
const sealFile = (() => {
  try {
    return readFileSync("/data/seal/seal.key", "utf8").trim();
  } catch {
    return "";
  }
})();
if (!process.env.SEAL && !sealFile) fail("no seal key was handed and the server made none in seal/seal.key");
const canaries = [process.env.CANARY, process.env.SEAL || sealFile].filter(Boolean);
const holds = (bytes) => canaries.some((canary) => bytes.includes(canary));
const read = (path) => {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
};
const pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
if (read("/proc/1/comm").toString().trim() !== "tini") fail(`PID 1 is ${read("/proc/1/comm").toString().trim()}, not tini`);
let checked = 0;
let pid1Pipe = false;
for (const pid of pids) {
  const what = read(`/proc/${pid}/cmdline`).toString().replaceAll("\0", " ").slice(0, 100);
  if (holds(read(`/proc/${pid}/environ`))) fail(`pid ${pid} (${what}) has a secret in its environment`);
  if (holds(read(`/proc/${pid}/cmdline`))) fail(`pid ${pid} (${what}) has a secret on its command line`);
  let fds = [];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {}
  const targets = new Map();
  for (const fd of fds) {
    try {
      targets.set(fd, readlinkSync(`/proc/${pid}/fd/${fd}`));
    } catch {}
  }
  const ends = new Map();
  for (const target of targets.values()) ends.set(target, (ends.get(target) ?? 0) + 1);
  for (const [fd, target] of targets) {
    const launcherPipe = /agentrun-serve\.[^/]+\/secrets/.test(target);
    if (launcherPipe && pid !== "1") fail(`pid ${pid} (${what}) holds the launcher's pipe on fd ${fd}`);
    if (launcherPipe) pid1Pipe = true;
    if (!target.startsWith("pipe:") && !target.endsWith(" (deleted)")) continue;
    // A pipe whose both ends the process holds is its own (Node's event loop keeps its signal lock as one byte in such
    // a pipe): read, it would lose that byte and never take the lock again. Nothing it hands another process is there.
    if (target.startsWith("pipe:") && ends.get(target) > 1) continue;
    try {
      const own = openSync(`/proc/${pid}/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
      const chunk = Buffer.alloc(65_536);
      // What it holds now, at most 4 MiB: a pipe a live process keeps writing (a server's log) never runs dry.
      for (let got, reads = 0; reads < 64 && (got = (() => { try { return readSync(own, chunk, 0, chunk.length, null); } catch { return 0; } })()) > 0; reads++) {
        if (holds(chunk.subarray(0, got))) fail(`pid ${pid} (${what})'s fd ${fd} has a secret unread`);
      }
      closeSync(own);
    } catch {}
  }
  checked++;
}
await api("POST", `/runs/${run.run_id}/cancel`);
for (const why of failed) console.error(`image custody: FAIL ${why}`);
if (failed.length) process.exit(1);
console.log(`image custody: PASS no secret in ${checked} processes; PID 1 ${pid1Pipe ? "holds the launcher's pipe, read empty" : "holds no launcher pipe"}; the run's process was handed its model key alone, runs as uid ${report.run.uid} with its group alone, no capability and no_new_privs, and neither it nor a program it starts reaches the data directory or the server's memory; two live runs (uids ${beacon.uid} and ${reached.run.uid}) reach neither the other's folder, environment, memory nor descriptors, nor the socket of the server's group ${socketGid}; a slot's uid lists and reads nothing of ${entries.length} entries of the data directory; the ended run's processes (one in a session of its own) and its file in /tmp are gone, and its slot's next run reaches nothing it left; a run reads its upload, and its next message writes beside the server's user's folders deep in its work folder`);
