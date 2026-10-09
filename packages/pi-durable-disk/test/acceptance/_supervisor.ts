// The acceptance rig's supervisor process: ensureRunning with localHost, once or every `everyMs`, in a process
// of its own (it holds the API key; instances never do; it must not share a process with a run's mount). Every
// control API call is timed, so the rig can split a takeover into decide, revoke, mint and start. One JSON line per
// decision on stdout: {tick, at, ms, decision, calls: [{call, at, ms, ok}]}; times are epoch milliseconds.
// Argument: one JSON object, see `Config`. The key comes from $ARCHIL_API_KEY.
import { configure, getDisk } from "disk";
import { localHost } from "../../src/hosts/local-host.ts";
import { ensureRunning, type SupervisorControl } from "../../src/supervise.ts";

export interface Config {
  disk: string;
  region: string;
  id: string;
  mountRoot: string;
  hostName: string;
  unitPrefix: string;
  /** Loop period; absent: one pass. */
  everyMs?: number;
  /** Exit after a pass that finds the run done or failed. */
  untilTerminal?: boolean;
  leaseExpiryMs?: number;
  /** false: the unit never restarts (a powered-off host has no process supervisor left). */
  restart?: boolean;
  runArgs: string[];
  env: Record<string, string>;
  tokenPrefix: string;
  tokenTtl: string;
  stopTimeoutMs?: number;
}

type Call = { call: string; at: number; ms: number; ok: boolean };

const now = () => performance.timeOrigin + performance.now();
const round = (x: number) => Math.round(x * 10) / 10;

/** The control API with every call's start and duration appended to `calls`. */
function timed<T extends object>(control: T, calls: Call[]): T {
  return new Proxy(control, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const at = now();
        try {
          const r = await value.apply(target, args);
          calls.push({ call: String(prop), at: round(at), ms: round(now() - at), ok: true });
          return r;
        } catch (err) {
          calls.push({ call: String(prop), at: round(at), ms: round(now() - at), ok: false });
          throw err;
        }
      };
    },
  });
}

const config = JSON.parse(process.argv[2] ?? "null") as Config;
const apiKey = process.env.ARCHIL_API_KEY;
if (!config || !apiKey) {
  process.stderr.write("usage: _supervisor.ts '<config json>' with $ARCHIL_API_KEY set\n");
  process.exit(2);
}
configure({ apiKey, region: config.region });
const disk = await getDisk(config.disk);
const base: SupervisorControl = {
  getObject: (key) => disk.getObject(key),
  headObject: (key) => disk.headObject(key),
  putObject: (key, body, options) => disk.putObject(key, body, options),
  addUser: (user) => disk.addUser(user),
  removeUser: (type, identifier) => disk.removeUser(type, identifier),
  listDelegations: () => disk.listDelegations(),
  revokeDelegation: (d) => disk.revokeDelegation(d),
};
const host = localHost({
  mountRoot: config.mountRoot,
  hostName: config.hostName,
  unitPrefix: config.unitPrefix,
  runArgs: config.runArgs,
  env: config.env,
  stopTimeoutMs: config.stopTimeoutMs ?? 5_000,
  ...(config.restart === false ? { restart: false } : {}),
});
const ref = { disk: config.disk, region: config.region, id: config.id };

let stopped = false;
process.once("SIGTERM", () => (stopped = true));
process.once("SIGINT", () => (stopped = true));

for (let tick = 1; ; tick++) {
  const calls: Call[] = [];
  const at = now();
  let line: Record<string, unknown>;
  let terminal = false;
  try {
    const decision = await ensureRunning(ref, host, {
      control: timed(base, calls),
      tokenPrefix: config.tokenPrefix,
      tokenTtl: config.tokenTtl,
      ...(config.leaseExpiryMs === undefined ? {} : { leaseExpiryMs: config.leaseExpiryMs }),
    });
    terminal = decision.action === "terminal";
    line = { tick, at: round(at), ms: round(now() - at), decision, calls };
  } catch (err) {
    const e = err as { code?: string; message?: string; cause?: { message?: string } };
    line = { tick, at: round(at), ms: round(now() - at), error: e.code ?? "ERROR", message: e.message, cause: e.cause?.message, calls };
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
  if (config.everyMs === undefined || stopped || (terminal && config.untilTerminal)) break;
  for (let left = config.everyMs - (now() - at); left > 0 && !stopped; left -= 50) await new Promise((r) => setTimeout(r, Math.min(50, left)));
  if (stopped) break;
}
process.exit(0);
