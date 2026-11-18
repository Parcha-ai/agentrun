// The faux model image-custody.sh hands the image's server and runner (copied into the container readable to every uid,
// so the check is this checkout's, whatever image it reads). A run on it answers, from inside the process its loop runs
// in, what that process holds and reaches, as names, numbers and words, never a value. Its first message says what:
//   "Report."  handed (each secret the launcher names, held or not, as the process's own secrets module answers
//              secret(name)), inEnv (the secret names still in its environment), dataOwner (the uid that owns the data
//              directory, the server's), run (the probe below, run in the run's process) and child (the same probe, run
//              in a program the run's process starts, as a tool's command starts).
//   "Beacon."  the run leaves a file in its own temporary folder, starts a program in a session of its own (setsid, out
//              of its process group), writes where both are to /tmp/image-custody-beacon.json, and holds its turn until
//              it is stopped: the live run another run reaches for.
//   "Reach {json}"  the run's process, and a program it starts, reach for the beacon's run (its folder, its file, its
//              process's environment, memory and descriptors, a socket of a group the server's user is given), each
//              "read" or "denied"; and the probe's status (uid, groups, capabilities) as for "Report.".
//   "Hold."    holds the turn until it is stopped, so the check reads every process while a turn is going.
//   "Inputs."  the run reads the upload its start named (file_ids) at inputs/custody/notes.txt in its work folder:
//              {inputs: its text, or the error's code}.
//   "Deep."    (a later message) the run writes beside what the server's user left deep in its work folder
//              (old/deep/next.txt, and a folder old/deep/more): {deep: "written", or the error's code}.
// Its work folder, from its HOME (its scratch folder, <data>/scratch/<agent>/<run>): <data>/disk/agents/<agent>/runs/<run>/work.
// The probe: its uid; its /proc/self/status lines (Uid, Gid, Groups, the five capability sets, NoNewPrivs); whether it
// lists the data directory; seal/seal.key and the SQLite store's files, each "read", "denied" or "absent"; and the
// processes of the data directory's uid whose memory it opens (/proc/<pid>/mem: the open is where ptrace's access check
// is made).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const secrets = await import("/opt/agentrun/packages/serve/dist/secrets.js");
const DATA = "/data";
const BEACON = "/tmp/image-custody-beacon.json";
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Self-contained, so a child runs its source as is. */
async function probe(data) {
  const { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } = await import("node:fs");
  const owner = statSync(data).uid;
  const named = ["seal/seal.key", "store.sqlite", "store.sqlite-wal", "store.sqlite-shm"];
  const files = {};
  for (const name of named) {
    try {
      const fd = openSync(`${data}/${name}`, "r");
      try {
        readSync(fd, Buffer.alloc(1), 0, 1, 0);
      } finally {
        closeSync(fd);
      }
      files[name] = "read";
    } catch (error) {
      files[name] = error.code === "ENOENT" ? "absent" : "denied";
    }
  }
  let listed = false;
  try {
    readdirSync(data);
    listed = true;
  } catch {}
  const memory = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    let status = "";
    try {
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      continue;
    }
    if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== owner) continue;
    try {
      closeSync(openSync(`/proc/${pid}/mem`, "r"));
      memory.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll("\0", " ").slice(0, 60)}`);
    } catch {}
  }
  const own = readFileSync("/proc/self/status", "utf8");
  const line = (name) => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(own)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const status = Object.fromEntries(["Uid", "Gid", "Groups", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"].map((name) => [name, line(name)]));
  return { uid: process.getuid(), status, listed, files, memory };
}

/** Self-contained too: what this process reaches of the beacon's run. */
async function reach(beacon) {
  const { closeSync, openSync, readdirSync, readFileSync, readlinkSync } = await import("node:fs");
  const { connect } = await import("node:net");
  const tried = (act) => {
    try {
      act();
      return "read";
    } catch (error) {
      return error.code === "ENOENT" ? "absent" : "denied";
    }
  };
  const out = {
    folder: tried(() => readdirSync(beacon.tmp)),
    file: tried(() => readFileSync(`${beacon.tmp}/beacon`)),
    environ: tried(() => readFileSync(`/proc/${beacon.pid}/environ`)),
    mem: tried(() => closeSync(openSync(`/proc/${beacon.pid}/mem`, "r"))),
    fds: tried(() => readdirSync(`/proc/${beacon.pid}/fd`)),
    fd0: tried(() => readlinkSync(`/proc/${beacon.pid}/fd/0`)),
    started: tried(() => readFileSync(`/proc/${beacon.started}/environ`)),
  };
  for (const [name, path] of [["socket", beacon.socket], ["dockerSocket", "/var/run/docker.sock"]]) {
    if (!path) continue;
    out[name] = await new Promise((resolve) => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.destroy();
        resolve("read");
      });
      socket.once("error", (error) => resolve(error.code === "ENOENT" ? "absent" : "denied"));
    });
  }
  return out;
}

const childOf = (source) => {
  const started = spawnSync(process.execPath, ["--input-type=module", "-e", `process.stdout.write(JSON.stringify(await (${source})))`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  try {
    return JSON.parse(started.stdout);
  } catch {
    return { error: `the child probe did not answer: ${(started.stderr ?? "").slice(0, 200)}` };
  }
};

const held = (faux) => new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));

/** The run's work folder, from its scratch folder (its HOME). */
const workOf = () => {
  const [agent, run] = (process.env.HOME ?? "").slice(`${DATA}/scratch/`.length).split("/");
  return `${DATA}/disk/agents/${agent}/runs/${run}/work`;
};
const codeOf = (act) => {
  try {
    return act();
  } catch (error) {
    return error.code ?? String(error.message).slice(0, 80);
  }
};

export default async function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1));
  if (last.includes("Hold.")) return held(faux);
  if (last.includes("Deep.")) {
    const deep = codeOf(() => {
      writeFileSync(`${workOf()}/old/deep/next.txt`, "next\n");
      mkdirSync(`${workOf()}/old/deep/more`);
      return "written";
    });
    return faux.message(JSON.stringify({ deep }));
  }
  if (first.startsWith("Inputs.")) return faux.message(JSON.stringify({ inputs: codeOf(() => readFileSync(`${workOf()}/inputs/custody/notes.txt`, "utf8")) }));
  if (first.startsWith("Beacon.")) {
    const tmp = process.env.TMPDIR ?? "";
    writeFileSync(`${tmp}/beacon`, "beacon\n");
    // A program that leaves the run's process group (a session of its own): the run's end must reap it all the same.
    const started = spawn("/usr/bin/setsid", ["/bin/sleep", "3600"], { stdio: "ignore" });
    started.unref();
    writeFileSync(BEACON, JSON.stringify({ pid: process.pid, uid: process.getuid(), tmp, started: started.pid }));
    return held(faux);
  }
  if (first.startsWith("Reach ")) {
    const beacon = JSON.parse(first.slice("Reach ".length));
    const run = { ...(await reach(beacon)), status: (await probe(DATA)).status, uid: process.getuid() };
    const child = childOf(`(async () => ({ ...(await (${reach.toString()})(${JSON.stringify(beacon)})), status: (await (${probe.toString()})(${JSON.stringify(DATA)})).status, uid: process.getuid() }))()`);
    return faux.message(JSON.stringify({ run, child }, null, 1));
  }
  const run = await probe(DATA);
  const child = childOf(`(${probe.toString()})(${JSON.stringify(DATA)})`);
  const report = {
    handed: Object.fromEntries(secrets.SECRET_NAMES.map((name) => [name, secrets.secret(name) !== undefined])),
    inEnv: secrets.SECRET_NAMES.filter((name) => name in process.env),
    dataOwner: statSync(DATA).uid,
    tmp: process.env.TMPDIR ?? "",
    run,
    child,
  };
  // One entry a line: a served answer holds no run of text past 8 KiB without whitespace (redactedAnswer).
  return faux.message(JSON.stringify(report, null, 1));
}
