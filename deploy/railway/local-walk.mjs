// The Railway template's service on a local Docker, run the way Railway runs it, so the template is walked with no
// Railway account (CI's deploy-compose job): its image, as the user RAILWAY_RUN_UID names, its start command in place of
// the image's entrypoint (exec form), its variables as a deploy renders them (the token and seal key generated, the
// public URL at a Railway-style domain), and a fresh volume at its mount path that is root's, as Railway mounts one
// (volume-nocopy: Docker would otherwise copy the image's /data, the server's own, into it).
// It checks that the volume starts as root's, then that the server is healthy, runs as the image's user (1000) and owns
// /data, that the first visit asks for the setup code, that the setup link is at the public URL, that AGENTRUN_TOKEN
// works as the code, and that a restart opens the same store under the same seal key. Removes everything at the end.
//   node deploy/railway/local-walk.mjs                     the template's image, pulled
//   AGENTRUN_IMAGE=<image> node deploy/railway/local-walk.mjs   another (CI: this checkout's, as deploy/walk/smoke.sh built it)
//   REPORT=<file>                                          the report in that file too
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { report } from "./publish-and-walk.mjs";
import { loadTemplate, onlyService, renderVariables, startArgv } from "./template.mjs";

export const DOMAIN = "agentrun-walk.up.railway.app";
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the walk publishes the container port on loopback only

/** `docker run`'s arguments for the service as Railway runs it: detached, named, as RAILWAY_RUN_UID's user, its variables
 *  from `envFile`, its port on this machine's loopback, the volume at each mount path with nothing copied in, and its
 *  start command as the entrypoint and its arguments. */
export function dockerRunArgs(service, { name, volume, envFile, image = service.source.image }) {
  const env = service.variables ?? {};
  const port = Number(env.PORT?.defaultValue);
  const [entrypoint, ...args] = startArgv(service.deploy.startCommand);
  const mounts = Object.values(service.volumeMounts ?? {}).flatMap((m) => ["-v", `${volume}:${m.mountPath}:nocopy`]);
  const user = env.RAILWAY_RUN_UID ? ["--user", env.RAILWAY_RUN_UID.defaultValue] : [];
  return ["run", "-d", "--name", name, ...user, "--env-file", envFile, "-p", `${LOOPBACK}::${port}`, ...mounts, "--entrypoint", entrypoint, image, ...args];
}

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { service } = onlyService(loadTemplate());
  const image = process.env.AGENTRUN_IMAGE || service.source.image;
  const name = `agentrun-railway-walk-${process.pid}`;
  const work = mkdtempSync(join(tmpdir(), "agentrun-railway-walk-"));
  const all = [];
  const row = (step, result, evidence) => (all.push([step, result, evidence]), console.error(`${step} | ${result} | ${evidence}`));
  const mountPath = Object.values(service.volumeMounts)[0].mountPath;
  const base = `https://${DOMAIN}`;
  try {
    const env = renderVariables(service, { domain: DOMAIN });
    const envFile = join(work, "env");
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
    const have = () => { try { return docker("image", "inspect", "-f", "{{.Id}}", image); } catch { return ""; } };
    const pulled = !have() && (docker("pull", "-q", image), true);
    row("image", "PASS", `${image} (${have()})${pulled ? ", pulled" : ", already here"}`);
    docker("volume", "create", name);
    const before = docker("run", "--rm", "--user", "0", "-v", `${name}:${mountPath}:nocopy`, "--entrypoint", "stat", image, "-c", "%u:%g", mountPath);
    if (before !== "0:0") throw new Error(`the fresh volume is ${before}'s, not root's as Railway mounts one: the walk would prove nothing`);
    row("volume is root's", "PASS", `${mountPath} on a fresh volume: ${before}, as Railway mounts one`);

    docker(...dockerRunArgs(service, { name, volume: name, envFile, image }));
    const hostPort = docker("port", name, `${env.PORT}/tcp`).split("\n")[0].split(":").pop();
    const local = `http://${LOOPBACK}:${hostPort}`;
    const healthy = async (what) => {
      for (let i = 0; i < 240; i++) {
        const r = await fetch(`${local}/v2/health`).catch(() => undefined);
        if (r?.status === 200) return r.json();
        if (docker("inspect", "-f", "{{.State.Running}}", name) !== "true") break;
        await sleep(500);
      }
      throw new Error(`${what}: /v2/health did not answer 200 within 120 s; the container's log:\n${docker("logs", "--tail", "40", name)}`);
    };
    row("healthy", "PASS", `GET /v2/health: 200 ${JSON.stringify(await healthy("first start"))}`);

    const owner = docker("exec", name, "stat", "-c", "%u:%g %a", mountPath);
    // Read as 1000 itself (an exec runs as the container's user, root here, unless told): a root process would show as 0.
    const status = docker("exec", "--user", "1000", name, "sh", "-c", "grep -h '^Uid:' /proc/[0-9]*/status 2>/dev/null; true");
    const uids = [...new Set(status.split("\n").map((l) => l.split(/\s+/)[1]))].sort().join(" ");
    if (owner !== "1000:1000 700" || uids !== "1000") throw new Error(`${mountPath} is ${owner} and the container's processes run as uid ${uids}: the server should own ${mountPath} (1000:1000 700) and nothing run as root`);
    row("server's own user", "PASS", `${mountPath}: ${owner}; every process in the container: uid ${uids}`);

    const session = await (await fetch(`${local}/v2/auth/session`)).json();
    if (!(session.accounts === true && session.password_set === false && session.setup_code === true)) throw new Error(`the first visit's session read is ${JSON.stringify(session)}`);
    row("first visit asks for the setup code", "PASS", `GET /v2/auth/session: ${JSON.stringify(session)}`);

    const line = docker("logs", name).split("\n").find((l) => l.startsWith(`Set up this server: ${base}/setup#code=`));
    if (!line) throw new Error(`no "Set up this server: ${base}/setup#code=" line in the log`);
    row("setup link at the public URL", "PASS", `the log's line starts "Set up this server: ${base}/setup#code=" (the code not shown)`);

    const setup = await fetch(`${local}/v2/setup`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ code: env.AGENTRUN_TOKEN, password: randomBytes(18).toString("base64url") }) });
    const answer = await setup.json().catch(() => ({}));
    if (setup.status !== 201 || answer.signed_in !== true) throw new Error(`POST /v2/setup with AGENTRUN_TOKEN as the code answered ${setup.status} ${JSON.stringify(answer)}`);
    row("token works as the setup code", "PASS", "POST /v2/setup with AGENTRUN_TOKEN as the code: 201, signed in");

    docker("restart", "-t", "35", name);
    await healthy("after a restart");
    const again = await (await fetch(`${local}/v2/auth/session`)).json();
    if (again.password_set !== true) throw new Error(`after a restart the session read is ${JSON.stringify(again)}: the password set before is gone`);
    row("restart keeps the store", "PASS", `after docker restart: healthy, password_set ${again.password_set} (same volume, same seal key)`);
  } catch (error) {
    row("stopped", "FAIL", error.message.split("\n")[0]);
    console.error(error.message);
  } finally {
    try { docker("rm", "-f", "-v", name); } catch {}
    try { docker("volume", "rm", "-f", name); } catch {}
    rmSync(work, { recursive: true, force: true });
  }
  const text = report(all);
  console.log(text);
  if (process.env.REPORT) writeFileSync(process.env.REPORT, `${text}\n`);
  return all.every((r) => r[1] === "PASS") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) process.exitCode = await main();
