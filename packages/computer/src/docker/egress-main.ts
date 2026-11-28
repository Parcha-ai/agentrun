// The entry a Docker computer's egress proxy container runs (egress.ts makes the container):
//
//	node egress-main.js --socket <path> --deadline <ISO time> (--allow <entries,...> | --open public) [--local <addresses,...>] [--hint <words>] [--max-tunnels <n>]
//
// `--open public` is every public host (a computer whose network is open); `--allow` a list. It refuses to start, exit 2
// and why on stdout, with neither or both, an empty list or a bad entry (no list never means open: only `--open public`
// does), with no socket, or with no deadline it can read. Started, it logs "egress cap tunnels=<n>", the cap in force, and
// "egress ready allow=<list>" (or "egress ready open") once its socket listens, then one line per decision. It ends, exit 0 and its socket removed, on SIGTERM or SIGINT and at
// the deadline, the computer's own: an orphaned proxy forwards nothing past its computer's end. `--local` is the Docker
// host's own addresses, refused as this host's. `--max-tunnels` is the operator's cap on connections open at once, 1 to
// MAX_TUNNELS_CEILING, default DEFAULT_MAX_TUNNELS; any other value refuses the start. It imports only node: modules and
// the proxy: it runs in a bare Node image.
import { DEFAULT_MAX_TUNNELS, EGRESS_READY, MAX_TUNNELS_CEILING, maxTunnelsOf, parseAllow, startEgressProxy } from "./egress-proxy.js";

/** Connections in all through one computer's proxy, for its life: serve's, for one run's box. */
const MAX_CONNECTIONS = 20_000;
/** The longest a Node timer holds; a later deadline is waited for in steps of it. */
const MAX_TIMER_MS = 2_147_483_647;
const FLAGS = new Set(["--socket", "--deadline", "--allow", "--open", "--local", "--hint", "--max-tunnels"]);

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
const open = given.get("--open");
if (open !== undefined && open !== "public") refuse(`--open takes "public", not ${JSON.stringify(open)}`);
if (open !== undefined && given.has("--allow")) refuse("both --open and --allow were given: a proxy serves one");
let allow: string[] | undefined;
if (open === undefined) {
	try {
		allow = parseAllow(given.get("--allow") ?? "");
	} catch (error) {
		refuse(`its list is not one (${(error as Error).message})`);
	}
	if (allow === undefined || allow.length === 0) refuse("no host list was given, and no --open public: no list never means every public host");
}
const socketPath = given.get("--socket") ?? "";
if (!socketPath.startsWith("/")) refuse("no socket path was given");
const deadline = Date.parse(given.get("--deadline") ?? "");
if (Number.isNaN(deadline)) refuse("no deadline was given as an ISO time");
const local = (given.get("--local") ?? "").split(",").filter(Boolean);
const capped = given.get("--max-tunnels");
const maxTunnels = capped === undefined ? DEFAULT_MAX_TUNNELS : maxTunnelsOf(capped);
if (maxTunnels === undefined) refuse(`--max-tunnels takes a whole number from 1 to ${MAX_TUNNELS_CEILING}, not ${JSON.stringify(capped)}`);

const proxy = await startEgressProxy({
	socketPath,
	maxTunnels: maxTunnels!,
	maxConnections: MAX_CONNECTIONS,
	log: say,
	...(allow === undefined ? {} : { allow }),
	alsoLocal: () => local,
	...(given.has("--hint") ? { allowHint: given.get("--hint")! } : {}),
});
const end = (why: string) => {
	say(`egress: ${why}, the proxy ends`);
	void proxy.close().finally(() => process.exit(0));
};
// The stop handlers come before the ready line: a caller that stops the proxy as soon as it reads ready gets exit 0.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => end(`${signal} came`));
say(`egress cap tunnels=${maxTunnels}`);
say(allow === undefined ? `${EGRESS_READY} open` : `${EGRESS_READY} allow=${allow.join(",")}`);
const wait = () => {
	const left = deadline - Date.now();
	if (left <= 0) return end(`the deadline ${new Date(deadline).toISOString()} has come`);
	setTimeout(wait, Math.min(left, MAX_TIMER_MS));
};
wait();
