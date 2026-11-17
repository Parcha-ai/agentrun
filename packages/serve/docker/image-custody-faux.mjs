// The faux model image-custody.sh hands the image's server and runner (copied into the container readable to every uid,
// so the check is this checkout's, whatever image it reads). A run on it answers, from inside the process its loop runs
// in, what that process holds and reaches, as names, numbers and words, never a value:
//   handed     each secret the launcher names, held or not, as the process's own secrets module answers secret(name)
//   inEnv      the secret names still in its environment
//   dataOwner  the uid that owns the data directory (the server's)
//   run        the probe below, run in the run's process
//   child      the same probe, run in a program the run's process starts (as a tool's command starts)
// The probe: its uid; whether it lists the data directory; seal/seal.key and the SQLite store's files, each "read",
// "denied" or "absent"; and the processes of the data directory's uid whose memory it opens (/proc/<pid>/mem: the open
// is where ptrace's access check is made). "Hold." holds the turn until it is stopped, so the check reads every process
// while a turn is going.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const secrets = await import("/opt/agentrun/packages/serve/dist/secrets.js");
const DATA = "/data";
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
  return { uid: process.getuid(), listed, files, memory };
}

export default async function reply(context, faux) {
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1));
  if (last.includes("Hold.")) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
  const run = await probe(DATA);
  const started = spawnSync(process.execPath, ["--input-type=module", "-e", `process.stdout.write(JSON.stringify(await (${probe.toString()})(${JSON.stringify(DATA)})))`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  let child;
  try {
    child = JSON.parse(started.stdout);
  } catch {
    child = { error: `the child probe did not answer: ${(started.stderr ?? "").slice(0, 200)}` };
  }
  const report = {
    handed: Object.fromEntries(secrets.SECRET_NAMES.map((name) => [name, secrets.secret(name) !== undefined])),
    inEnv: secrets.SECRET_NAMES.filter((name) => name in process.env),
    dataOwner: statSync(DATA).uid,
    run,
    child,
  };
  return faux.message(JSON.stringify(report));
}
