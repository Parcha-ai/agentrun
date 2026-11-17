// image-custody.sh's check, run inside the container (`docker exec -i ... node --input-type=module -`): one agent on the
// faux model (image-custody-faux.mjs), a run that reports what its process holds and reaches, then a run holding its turn
// while every process is read. Every failure is said, one line each, and the check exits 1 after the last.
// Its environment: CANARY (the prefix of every canary but the seal key's), SEAL (the seal key's canary; empty, the key in
// seal/seal.key is one), TOKEN (the API
// token), KEYS_ONLY=1 to read only what a run's process holds (a release from before a run had a uid of its own).
import { closeSync, constants, openSync, readdirSync, readFileSync, readlinkSync, readSync } from "node:fs";

const failed = [];
const fail = (why) => void failed.push(why);
const stop = (why) => {
  console.error(`image custody: FAIL ${why}`);
  process.exit(1);
};
const base = "http://127.0.0.1:7340/v2"; // # key-gate: loopback-rule the check reaches the server inside its own container, on loopback only
const api = (method, path, body) => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  if ((await fetch(`${base}/health`).then((r) => r.status, () => 0)) === 200) break;
  if (i > 600) stop("the server never answered /v2/health");
  await sleep(200);
}
// On an OpenAI model (the faux model answers): OpenAI's key is the one key its run's process needs.
const made = await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: [], model: "openai/gpt-6.1-sol" } });
if (made.status !== 201) stop(`the agent was not made (${made.status} ${JSON.stringify(made.body)})`);
const run = (await api("POST", "/agents/custody/runs", { input: { content: "Report." } })).body;
let view;
for (let i = 0; (view = (await api("GET", `/runs/${run.run_id}`)).body).status !== "completed"; i++) {
  if (i > 600 || view?.status === "failed") stop(`the run did not complete: ${JSON.stringify(view)}`);
  await sleep(200);
}
const report = JSON.parse(view.result.final_answer);
const held = Object.entries(report.handed).filter(([, has]) => has).map(([name]) => name);
console.log(`REPORT handed=${held.join(",")} inEnv=${report.inEnv.join(",")}`);
console.log(`REPORT dataOwner=${report.dataOwner} run=${JSON.stringify(report.run)} child=${JSON.stringify(report.child)}`);
if (!held.includes("OPENAI_API_KEY")) fail("the run's process was not handed its model key");
if (held.join() !== "OPENAI_API_KEY") fail(`the run's process was handed ${held.join(", ")}, not its model's key alone`);
if (report.inEnv.length) fail(`the run's process has ${report.inEnv.join(", ")} in its environment`);
if (process.env.KEYS_ONLY !== "1") {
  for (const [who, seen] of [["the run's process", report.run], ["a program the run starts", report.child]]) {
    if (seen.error) {
      fail(`${who}: ${seen.error}`);
      continue;
    }
    if (seen.uid === report.dataOwner) fail(`${who} runs as uid ${seen.uid}, the server's own, which owns the data directory`);
    if (seen.listed) fail(`${who} lists the data directory`);
    const read = Object.entries(seen.files).filter(([, how]) => how === "read").map(([name]) => name);
    if (read.length) fail(`${who} reads ${read.join(", ")}`);
    if (seen.memory.length) fail(`${who} opens the memory of ${seen.memory.join("; ")}`);
  }
}

// A turn held open, so every process that holds anything only while a turn goes is there to be read.
await api("POST", `/runs/${run.run_id}/messages`, { content: "Hold." });
for (let i = 0; (await api("GET", `/runs/${run.run_id}`)).body.state !== "working"; i++) {
  if (i > 300) stop("the held turn never worked");
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
  for (const fd of fds) {
    let target;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const launcherPipe = /agentrun-serve\.[^/]+\/secrets/.test(target);
    if (launcherPipe && pid !== "1") fail(`pid ${pid} (${what}) holds the launcher's pipe on fd ${fd}`);
    if (launcherPipe) pid1Pipe = true;
    if (!target.startsWith("pipe:") && !target.endsWith(" (deleted)")) continue;
    try {
      const own = openSync(`/proc/${pid}/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
      const chunk = Buffer.alloc(65_536);
      for (let got; (got = (() => { try { return readSync(own, chunk, 0, chunk.length, null); } catch { return 0; } })()) > 0; ) {
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
console.log(`image custody: PASS no secret in ${checked} processes; PID 1 ${pid1Pipe ? "holds the launcher's pipe, read empty" : "holds no launcher pipe"}; the run's process was handed its model key alone${process.env.KEYS_ONLY === "1" ? " (keys only: its uid and reach not read)" : `, runs as uid ${report.run.uid}, and neither it nor a program it starts reaches the data directory or the server's memory`}`);
