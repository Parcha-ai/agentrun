// The entry a Docker computer's egress proxy container runs (egress.ts makes the container):
//
//	node egress-main.js --socket <path> --deadline <ISO time> --allow <entries,...> [--local <addresses,...>] [--hint <words>]
//
// It refuses to start, exit 2 and why on stdout, with no list, an empty one or a bad entry (a proxy with none would reach
// every public host), with no socket, or with no deadline it can read. Started, it logs "egress ready allow=<list>" once
// its socket listens, then one line per decision. It ends, exit 0 and its socket removed, on SIGTERM or SIGINT and at
// the deadline, the computer's own: an orphaned proxy forwards nothing past its computer's end. `--local` is the Docker
// host's own addresses, refused as this host's. It imports only node: modules and the proxy: it runs in a bare Node image.
import { EGRESS_READY, parseAllow, startEgressProxy } from "./egress-proxy.js";

/** Connections open at once through one computer's proxy, and in all for its life: serve's, for one run's box. */
const MAX_TUNNELS = 64;
const MAX_CONNECTIONS = 20_000;
/** The longest a Node timer holds; a later deadline is waited for in steps of it. */
const MAX_TIMER_MS = 2_147_483_647;
const FLAGS = new Set(["--socket", "--deadline", "--allow", "--local", "--hint"]);

const say = (line: string) => process.stdout.write(`${line}\n`);
const refuse = (why: string): never => {
	say(`egress: ${why}, so the proxy does not start`);
	process.exit(2);
};

const given = new Map<string, string>();
const argv = process.argv.slice(2);
for (let at = 0; at < argv.length; at += 2) {
	const flag = argv[at]!;
	if (!FLAGS.has(flag) || given.has(flag) || at + 1 >= argv.length) refuse(`${JSON.stringify(flag)} is not one of ${[...FLAGS].join(", ")}, each once and with a value`);
	given.set(flag, argv[at + 1]!);
}
let allow: string[] = [];
try {
	allow = parseAllow(given.get("--allow") ?? "");
} catch (error) {
	refuse(`its list is not one (${(error as Error).message})`);
}
if (allow.length === 0) refuse("no host list was given: one with none would reach every public host");
const socketPath = given.get("--socket") ?? "";
if (!socketPath.startsWith("/")) refuse("no socket path was given");
const deadline = Date.parse(given.get("--deadline") ?? "");
if (Number.isNaN(deadline)) refuse("no deadline was given as an ISO time");
const local = (given.get("--local") ?? "").split(",").filter(Boolean);

const proxy = await startEgressProxy({
	socketPath,
	maxTunnels: MAX_TUNNELS,
	maxConnections: MAX_CONNECTIONS,
	log: say,
	allow,
	alsoLocal: () => local,
	...(given.has("--hint") ? { allowHint: given.get("--hint")! } : {}),
});
say(`${EGRESS_READY} allow=${allow.join(",")}`);

const end = (why: string) => {
	say(`egress: ${why}, the proxy ends`);
	void proxy.close().finally(() => process.exit(0));
};
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => end(`${signal} came`));
const wait = () => {
	const left = deadline - Date.now();
	if (left <= 0) return end(`the deadline ${new Date(deadline).toISOString()} has come`);
	setTimeout(wait, Math.min(left, MAX_TIMER_MS));
};
wait();
