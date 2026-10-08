// Example 01: kill a durable chat on one host and watch it resume on another.
//
//   node examples/01-durable-chat/demo.ts [options]        (options: --help)
//
// Host A starts the run. After the third answer the demo powers host A off (its instance and its FUSE daemon die at
// once). Host B's supervisor finds the dead client's claim orphaned, revokes it, starts a new instance, and the chat
// goes on from the last committed message. Every command the demo runs is printed.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup, instanceUid, fail, fault, followLog, note, parseOptions, preflight, report, say, scratchDir, shareWith, startedUnit, superviseLoop, superviseOnce, USAGE, waitFor,
  type HostSpec,
} from "../lib/demo.ts";
import type { HostHandle } from "@parcha/pi-durable-archil";

if (process.argv.includes("--help")) {
  console.log(`usage: node demo.ts [options]\n${USAGE}`);
  process.exit(0);
}
const opts = parseOptions("chat", ["kill"], process.argv.slice(2));

const dir = scratchDir(opts, "pda-chat-");
shareWith(opts, dir);
const logFile = join(dir, "chat.jsonl");
const app = fileURLToPath(new URL("./app.ts", import.meta.url));
const env = { EXAMPLE_LOG: logFile, CHAT_PACE_MS: "1500", NODE_NO_WARNINGS: "1" };
const runFlags = ["--app", app];
// With --host docker the instances write the app's log from their containers: the scratch directory is mounted in.
const dockerArgs = [`--mount=type=bind,source=${dir},target=${dir}`];
const hostA: HostSpec = { name: "host-a", mountRoot: opts.mountRoots.a, env, restart: false, dockerArgs };
const hostB: HostSpec = { name: "host-b", mountRoot: opts.mountRoots.b, env, restart: true, dockerArgs };

const handles: HostHandle[] = [];
let finished = false;
let started = false;
const log = followLog(logFile, (e) => {
  if (e.event === "open") note("chat", `generation ${e.generation} opened on ${e.host} as ${instanceUid(opts, e)} (${e.alreadyAnswered} messages already answered)`);
  if (e.event === "answered") note("chat", `message ${e.n} answered by generation ${e.generation}`);
});
try {
  const problems = preflight(opts);
  if (problems.length) fail(`this host cannot run the demo yet:\n  - ${problems.join("\n  - ")}`);
  say(`host A: start run ${opts.id} (the supervisor creates its directory on the disk, then starts an instance)`);
  const a = superviseOnce(opts, hostA, ["--create", ...runFlags]);
  started = true;
  const handleA = startedUnit(a.lines);
  handles.push(handleA);
  await waitFor("three answers", () => log.events.filter((e) => e.event === "answered").length >= 3, 120_000);

  say("host A loses power: its instance and its FUSE daemon are killed at once");
  fault("kill", handleA);

  say("host B: a supervisor on another machine sees the dead client, revokes its claim and starts an instance");
  const loop = superviseLoop(opts, hostB, "2s", runFlags);
  try {
    const done = await waitFor("the chat to finish on host B", () => log.events.find((e) => e.event === "done"), 180_000);
    const started = loop.lines.find((l) => l.action === "started");
    if (started?.handle) handles.push(started.handle as HostHandle);
    finished = true;
    say("the transcript, read back from the run's store");
    for (const line of (log.events.find((e) => e.event === "transcript")!.lines as string[])) console.log(`    ${line}`);
    const generations = new Set(log.events.filter((e) => e.event === "answered").map((e) => e.generation));
    const answered = log.events.filter((e) => e.event === "answered").map((e) => e.n as number);
    say(`generations that answered: ${[...generations].join(", ")}; messages answered more than once: ${answered.length - new Set(answered).size}; finished by generation ${String(done.generation)}`);
    if (generations.size < 2 || answered.length !== new Set(answered).size) process.exitCode = 1;
  } finally {
    await loop.stop();
  }
} catch (error) {
  report(error);
} finally {
  log.stop();
  if (started) await cleanup(opts, handles, [hostA, hostB], finished);
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
}
// The disk SDK keeps its HTTP connections open for about 100 s after the last call; the demo is done.
process.exit(process.exitCode ?? 0);
