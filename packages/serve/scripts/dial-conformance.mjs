#!/usr/bin/env node
// The computer conformance suite's Core, with --long, for a provider whose machines dial the server (facts.connect
// "dial", such as Fly Machines): the run happens inside the server its machines reach. It stands up serve's own attach
// routes (createAttachRoutes: the minted tokens, the attach socket's upgrade and the daemon route) over a store in memory,
// on an HTTP server bound to $PORT that answers GET /v2/health 200, and builds the provider with the dial that server
// gives: AGENTRUN_PUBLIC_URL, the tokens it mints and its attach hub. It creates nothing until AGENTRUN_PUBLIC_URL's
// /v2/health is answered by this process (reachesThisRun), as a host swapping instances answers from the old one first.
// Then it runs Core, provider.deadline and drift.arch
// among it, and prints the report as JSON between two marker lines, DIAL-CONFORMANCE-REPORT-BEGIN and
// DIAL-CONFORMANCE-REPORT-END, so a log that holds other lines still yields it. A desktop's run first prints the last
// whole-screen shot its cases read, as base64 lines between DIAL-CONFORMANCE-FRAME-BEGIN <sha256> <bytes> and
// DIAL-CONFORMANCE-FRAME-END (keepingFrames, frameLines). Then it idles, /v2/health still
// answered, until SIGTERM or SIGINT ends it with the run's status: a host that restarts an exited process (Render's)
// would start a second run. With --exit it exits instead: 0 when Core passes, else 1. A refusal before the server
// listens (a usage error, no AGENTRUN_PUBLIC_URL or PORT) exits 1 either way.
//
//   node packages/serve/scripts/dial-conformance.mjs --provider fly
//
// reads its settings from its own environment: the provider module's names (Fly's COMPUTER_FLY_API_TOKEN and
// COMPUTER_FLY_APP), AGENTRUN_PUBLIC_URL (the https address the internet reaches this process at) and PORT. --provider
// takes a registry id or a conformance module's path. --only (the conformance CLI's) narrows the run to groups and case
// ids, for a test over a fake host whose daemon answers some of them; such a run is partial at best, and exits 0 when
// every case it ran passed. No token or key is printed: every value of the module's secret names, and every machine
// token, is taken out of what it writes.
//
// drift.version under dial: a machine runs the computerd this server serves, and the image holds no Go to build one of
// another version, so the drifted twin's machines are served a copy of the daemon with its version string, found exactly
// once, changed in place (same length, printable): the copy's sha256 is the twin's, and only the twin's tokens are
// served it. A fixture of this script alone: no serve route knows of it. The report names the copy's sha256 and version,
// and the versions the twin's refused hellos reported (driftedDaemon), which must be the copy's.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ATTACH_HELLO_MS, ATTACH_PATH, ATTACH_SUBPROTOCOL, AttachHub, DAEMON_PATH, descriptorOf, hostedDaemonPath, isProviderId, providerModule } from "@parcha/agentrun-computer";
import WebSocket from "ws";
import { isMain } from "../../../scripts/is-main.mjs";
import { MACHINE_TOKEN_SOURCE } from "../../computer/dist/attach.js";
import { plantSecrets } from "../../computer/dist/conformance/cli.js";
import { casesFor, runConformance } from "../../computer/dist/conformance/index.js";
import { createAttachRoutes, sha256Hex } from "../dist/computer-attach.js";

const BEGIN = "DIAL-CONFORMANCE-REPORT-BEGIN";
const END = "DIAL-CONFORMANCE-REPORT-END";
const FRAME_BEGIN = "DIAL-CONFORMANCE-FRAME-BEGIN";
const FRAME_END = "DIAL-CONFORMANCE-FRAME-END";
const USAGE = "usage: node dial-conformance.mjs --provider <registry id or module path> [--only <groups and case ids>] [--exit], with AGENTRUN_PUBLIC_URL and PORT set";
/** A name of a module's ENV that holds a secret (the conformance CLI's rule). */
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET)(_|$)/;
/** `text` with every machine token in it redacted by its shape, whether or not this run minted it. */
export const scrubMachineTokens = (text) => text.replace(new RegExp(MACHINE_TOKEN_SOURCE, "g"), "art_[redacted]");

const say = (line) => process.stderr.write(`dial-conformance: ${line}\n`);

/** --provider's value, --only's groups and case ids when it is given, and --exit; anything else is a usage error. */
function argsOf(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--exit" && args.exit === undefined) {
			args.exit = true;
			continue;
		}
		const value = argv[++i];
		if (!value || (flag !== "--provider" && flag !== "--only") || args[flag.slice(2)] !== undefined) throw new Error(USAGE);
		args[flag.slice(2)] = flag === "--only" ? value.split(",").map((part) => part.trim()).filter(Boolean) : value;
	}
	if (args.provider === undefined) throw new Error(USAGE);
	return args;
}

/** The conformance module for a registry id or a path, and what a registry provider declares of itself. */
async function moduleOf(name) {
	const file = isProviderId(name) ? await providerModule(name) : await import(pathToFileURL(resolve(name)).href);
	const module = typeof file.conformance === "function" ? await file.conformance() : file;
	if (typeof module.createProvider !== "function") throw new Error(`${name}: its conformance module exports no createProvider()`);
	return { module, declared: isProviderId(name) ? descriptorOf(name)?.capabilities : undefined };
}

/**
 * Minted tokens in this process's memory, as serve's store keeps them (store.ts MintedTokens: the token's SHA-256 by its
 * machine), and check(token, at): the machine the attach route takes it for at a time, for the DialKit.
 */
function memoryMintedTokens(now = Date.now) {
	const rows = new Map();
	const view = ({ tokenSha256: _, ...row }) => row;
	const prune = () => {
		for (const [machine, row] of rows) if (row.expiresAt <= now()) rows.delete(machine);
	};
	return {
		// The row the store contract keeps: a runner, its incarnation and a run only where the mint names them, else null
		// (this process minted it: the attach route takes the machine here, and relays none).
		async mint({ machine, tokenSha256, kind, os, arch, expiresAt, runner, incarnation, run }) {
			prune();
			rows.set(machine, { machine, tokenSha256, kind, os, arch, expiresAt, revokedAt: null, createdAt: now(), runner: runner ?? null, incarnation: incarnation ?? null, run: run ?? null, refused: null });
		},
		async byToken(tokenSha256) {
			const row = [...rows.values()].find((one) => one.tokenSha256 === tokenSha256 && one.revokedAt === null && one.expiresAt > now());
			return row && view(row);
		},
		async get(machine) {
			const row = rows.get(machine);
			return row && row.expiresAt > now() ? view(row) : undefined;
		},
		async revoke(machine) {
			const row = rows.get(machine);
			if (row === undefined || row.revokedAt !== null || row.expiresAt <= now()) return false;
			row.revokedAt = now();
			return true;
		},
		async refuse(tokenSha256, words) {
			const row = [...rows.values()].find((one) => one.tokenSha256 === tokenSha256);
			if (row !== undefined) row.refused = words;
		},
		check(token, at) {
			const sha = sha256Hex(token);
			const row = [...rows.values()].find((one) => one.tokenSha256 === sha);
			return row !== undefined && row.revokedAt === null && row.expiresAt > at.getTime() ? row.machine : undefined;
		},
	};
}

/** This server pairs no computer: the routes are machines only, and nothing here makes a pairing code. */
const NO_PAIRING = new Proxy(
	{},
	{
		get: (_, name) =>
			name === "then"
				? undefined
				: async () => {
						throw new Error(`this server pairs no computer (${String(name)})`);
					},
	},
);

/** computerd-fixture for linux/amd64, which the server's image builds next to computerd (packages/serve/docker/Dockerfile). */
export const FIXTURE_PATH = fileURLToPath(new URL("../../computer/dist/computerd-fixture-linux-amd64", import.meta.url));

/** What a run of `kind` checks effects with: a desktop's computerd-fixture (its screen and input cases skip without it, and
 *  Core cannot pass), none otherwise. */
export const fixtureFor = (kind, path = FIXTURE_PATH) => (kind === "desktop" ? path : undefined);

/**
 * Keeps the last whole-screen shot a case read to its end over `provider`'s connections (screen.shot with no region,
 * then its screen.read chunks to eof), as the computer gave it: a live run's frame of the desktop. A fixture of this
 * script alone. `kept.png` is undefined until one is whole.
 */
export function keepingFrames(provider) {
	const kept = { png: undefined };
	const connect = provider.connect.bind(provider);
	provider.connect = async (...args) => {
		const connected = await connect(...args);
		if (!connected.ok) return connected;
		const { client } = connected.value;
		const call = client.call.bind(client);
		const reading = new Map();
		client.call = async (method, params, options) => {
			const result = await call(method, params, options);
			if (!result.ok) return result;
			const whole = method === "screen.shot" && params?.region === undefined;
			const id = method === "screen.read" ? params.id : whole ? result.value.id : undefined;
			if (id === undefined || (method === "screen.read" && !reading.has(id))) return result;
			const parts = [...(reading.get(id) ?? []), Buffer.from(result.value.data, "base64")];
			if (result.value.eof) {
				reading.delete(id);
				kept.png = Buffer.concat(parts);
			} else reading.set(id, parts);
			return result;
		};
		return connected;
	};
	return kept;
}

/** The lines a kept frame is printed as: its sha256 and size after the begin marker, its base64 in lines of `width`. */
export function frameLines(png, width = 512) {
	const data = png.toString("base64");
	const lines = [];
	for (let at = 0; at < data.length; at += width) lines.push(data.slice(at, at + width));
	return [`${FRAME_BEGIN} ${createHash("sha256").update(png).digest("hex")} ${png.length}`, ...lines, FRAME_END];
}

/** The version a drifted daemon reports: the provider's, its last character changed, so the bytes keep their length. */
export const driftedVersion = (version) => `${version.slice(0, -1)}${version.endsWith("x") ? "y" : "x"}`;

/** Go's name for this process's architecture: the daemon builds this machine can run. */
const HERE = { x64: "amd64", arm64: "arm64" }[process.arch];

/** The drift check's words for a hello of another version (computer src/drift.ts helloDrift): the daemon's version. */
const VERSION_DRIFT = /hello: the daemon reports version (\S+), expected (\S+)/;

/**
 * `bytes` with the one `from` in them written over with `to`: the same length, printable ASCII. Refused unless `from`
 * occurs exactly once, so nothing but the version string the build stamped (-X main.version) changes.
 */
export function patchVersion(bytes, from, to) {
	if (to.length !== from.length || !/^[\x21-\x7e]+$/.test(to)) throw new Error(`the drifted version ${JSON.stringify(to)} is not ${from.length} printable characters, as ${from} is`);
	const was = Buffer.from(from);
	const at = bytes.indexOf(was);
	const again = at === -1 ? -1 : bytes.indexOf(was, at + 1);
	if (at === -1 || again !== -1) throw new Error(`the daemon holds the version string ${from} ${at === -1 ? "nowhere" : "more than once"}: the drift case changes it only where it occurs exactly once`);
	const patched = Buffer.from(bytes);
	Buffer.from(to).copy(patched, at);
	return patched;
}

/**
 * A copy of the daemon for `arch` at `path` in a directory of its own, its version string `from` written over with `to`:
 * its path and sha256. A copy this machine can run is run once (`computerd version`), and must say `to`: one that does
 * not start, or says another version, fails the drift case here rather than in a machine.
 */
function driftedDaemon(arch, path, from, to) {
	const bytes = patchVersion(readFileSync(path), from, to);
	const dir = mkdtempSync(join(tmpdir(), "dial-conformance-drift-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	const out = join(dir, "computerd");
	writeFileSync(out, bytes);
	chmodSync(out, 0o755);
	if (arch === HERE) {
		const said = execFileSync(out, ["version"], { encoding: "utf8", env: {}, timeout: 10_000 }).trim();
		if (said !== to) throw new Error(`the drift case's copy of ${path} says version ${said}, not ${to}`);
	}
	return { path: out, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** A JSON answer. */
function answer(res, status, body, headers = {}) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), "cache-control": "no-store", ...headers });
	res.end(text);
}

/** The header this process's GET /v2/health carries: its run's id, which no other process answers with. */
const RUN_HEADER = "x-dial-conformance-run";

/** One GET of `url` on a new connection, closed after it (no keep-alive agent): its status and RUN_HEADER. */
function askOnce(url, signal) {
	return new Promise((done, fail) => {
		const get = new URL(url).protocol === "https:" ? httpsGet : httpGet;
		const req = get(url, { agent: false, headers: { "cache-control": "no-store" }, timeout: 10_000, ...(signal ? { signal } : {}) }, (res) => {
			res.on("error", fail);
			res.on("end", () => done({ status: res.statusCode, run: res.headers[RUN_HEADER] }));
			res.resume();
		});
		req.on("timeout", () => req.destroy(new Error("no answer within 10 s")));
		req.on("error", fail);
	});
}

/**
 * Resolves once `publicUrl`'s GET /v2/health is answered by this process (its run's id in RUN_HEADER) `times` times in a
 * row, asked every `every` ms; throws after `within` ms. A host that swaps instances (Render's deploy: the new process
 * listens while the old still holds the address) reaches another process first, and a machine that dials it then is
 * refused its token there (11-17: a Cloudflare container dialed 14 s after its create, the address still reached the
 * previous deploy, the machine was answered 401 and the whole of Core failed on "create did not answer"). Each ask is
 * on a connection of its own (`ask`), as a machine's dial is: a host may pick its instance per connection, and a kept-alive
 * one would go on reaching the process it first reached. `signal` stops an ask in flight and the wait between asks.
 */
export async function reachesThisRun(publicUrl, run, signal, { within = 600_000, every = 1_000, times = 3, ask = askOnce } = {}) {
	const url = `${publicUrl.replace(/\/+$/, "")}/v2/health`;
	const start = Date.now();
	let row = 0;
	let other = 0;
	let last = "no answer yet";
	while (row < times) {
		signal?.throwIfAborted();
		if (Date.now() - start > within) throw new Error(`${url} did not reach this process within ${Math.round(within / 1000)} s (last: ${last}): the machines would dial another, so nothing was created`);
		try {
			const res = await ask(url, signal);
			const mine = res.run === run;
			last = mine ? "this process" : `${res.status} from another process`;
			if (!mine && other++ === 0) say(`${url} reaches another process (a host still swapping instances); waiting until it reaches this one`);
			row = mine ? row + 1 : 0;
		} catch (error) {
			if (signal?.aborted) throw error;
			last = error instanceof Error ? error.message : String(error);
			row = 0;
		}
		if (row < times) await delay(every, undefined, signal ? { signal } : {});
	}
	say(`${url} reaches this process (${times} answers in a row, after ${Math.round((Date.now() - start) / 1000)} s and ${other} answers from another)`);
}

/** The run: its exit status. `state.listening` is set once the server listens, from which point a run may have begun. */
async function main({ provider: name, only, exit }, env, state) {
	const publicUrl = env.AGENTRUN_PUBLIC_URL;
	if (!publicUrl) throw new Error(`AGENTRUN_PUBLIC_URL is not set: the provider's machines dial it, so it is the https address the internet reaches this process at\n${USAGE}`);
	const port = Number(env.PORT);
	if (!env.PORT || !Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`PORT is the port this process listens on, not ${JSON.stringify(env.PORT ?? "")}\n${USAGE}`);
	const { module, declared } = await moduleOf(name);
	const run = randomUUID();

	const store = memoryMintedTokens();
	const hub = new AttachHub();
	const attach = createAttachRoutes({
		store: { pairedComputers: NO_PAIRING, mintedTokens: store },
		hub,
		machinesOnly: true,
		log: (event, fields) => say(`${event} ${JSON.stringify(fields)}`),
	});
	/**
	 * Each machine's token, by its name (DialKit.token); the drifted twin's machines, the daemon copy each arch's are
	 * served ({ path, sha256, version }), and the version each refused hello of the twin's reported.
	 */
	const tokens = new Map();
	const drift = { machines: new Set(), copies: new Map(), hellos: [] };
	const minting = (into) => ({
		async mint(machine, mint) {
			const token = await attach.machineTokens.mint(machine, mint);
			tokens.set(machine, token);
			into?.add(machine);
			return token;
		},
		revoke: (machine) => attach.machineTokens.revoke(machine),
		refused: (machine) => attach.machineTokens.refused(machine),
	});
	const machineOf = async (authorization) => {
		const bearer = /^Bearer (\S+)$/.exec(String(authorization ?? ""))?.[1];
		return bearer === undefined ? undefined : (await store.byToken(sha256Hex(bearer)))?.machine;
	};

	// A request's path and query from its raw target, as serve's own server reads them: a target no URL parses (`//[/`)
	// is a path that matches no route, not a throw.
	const targetOf = (req) => {
		const target = req.url ?? "/";
		const at = target.indexOf("?");
		return at < 0 ? { path: target, query: new URLSearchParams() } : { path: target.slice(0, at), query: new URLSearchParams(target.slice(at + 1)) };
	};
	const server = createServer((req, res) => {
		void (async () => {
			const { path, query } = targetOf(req);
			if (req.method === "GET" && path === "/v2/health") return answer(res, 200, { status: "ok" }, { [RUN_HEADER]: run });
			if ((req.method === "GET" || req.method === "HEAD") && path === DAEMON_PATH) {
				const arch = query.get("arch");
				const file = await attach.daemon(req.headers.authorization, arch);
				const machine = await machineOf(req.headers.authorization);
				const bytes = await readFile(drift.machines.has(machine) ? (drift.copies.get(arch)?.path ?? file) : file);
				res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length), "cache-control": "no-store" });
				return void res.end(req.method === "HEAD" ? undefined : bytes);
			}
			answer(res, 404, { error: { code: "not_found", message: `this server answers GET /v2/health, ${DAEMON_PATH} and the ${ATTACH_PATH} socket alone` } });
		})().catch((error) => {
			const status = Number.isInteger(error?.status) ? error.status : 500;
			if (!res.headersSent) answer(res, status, { error: { code: error?.code ?? "internal", message: error?.message ?? String(error) } }, error?.headers ?? {});
			else res.destroy();
		});
	});
	server.on("upgrade", (req, socket, head) => {
		socket.on("error", () => undefined);
		const deny = (status, words = "", headers = {}) => {
			const lines = Object.entries({ ...headers, "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(words)) }).map(([key, value]) => `${key}: ${value}\r\n`).join("");
			socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${lines}\r\n${words}`);
		};
		if (targetOf(req).path !== ATTACH_PATH) return deny("404 Not Found");
		attach.upgrade(req, socket, head, deny);
	});
	await new Promise((done, fail) => server.once("error", fail).listen(port, () => done()));
	state.listening = true;
	const local = `ws://127.0.0.1:${server.address().port}${ATTACH_PATH}`;
	say(`listening on port ${server.address().port}; the machines dial ${publicUrl}`);

	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const notes = [];
	const options = { env, dial: { url: publicUrl, tokens: minting(), hub }, onNote: (note) => notes.push({ computer: note.computer, note: note.note }) };
	try {
		const provider = await module.createProvider(options);
		// A desktop's run keeps a frame of its screen, printed before the report: what the computer showed.
		const frames = provider.capabilities().kind === "desktop" ? keepingFrames(provider) : undefined;
		// The same provider with no public address, its host's creates counted: provider.dial-token's unreachable().
		const bare = await module.createProvider({ ...options, dial: { tokens: minting(), hub } });
		let creates = 0;
		const host = bare.host;
		if (host !== undefined) {
			const create = host.create.bind(host);
			host.create = (...args) => (creates++, create(...args));
		}
		const kit = {
			check: (token, at) => store.check(token, at),
			token: (ref) => tokens.get(ref.name),
			dialAs(token, hello) {
				// The server's attach route as a machine dials it, answering the hub's hello with `hello`: the close code.
				const ws = new WebSocket(local, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${token}` } });
				ws.on("error", () => undefined);
				ws.on("message", (data) => {
					const request = JSON.parse(String(data));
					if (typeof request.id !== "number") return;
					const reply = request.method === "hello" ? { result: hello } : { error: { code: -32601, message: `${request.method} is not a method` } };
					ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
				});
				return new Promise((done) => {
					const late = setTimeout(() => (ws.terminate(), done(undefined)), 2 * ATTACH_HELLO_MS);
					ws.once("close", (code) => (clearTimeout(late), done(code)));
				});
			},
			unreachable() {
				const before = creates;
				return { provider: bare, creates: () => creates - before };
			},
		};
		const secretNames = Object.values(module.ENV ?? {}).filter((one) => typeof one === "string" && SECRET_NAME.test(one));
		// No secret leaves this process: the module's secret values and every machine token are taken out of what it writes.
		const scrub = (text) => [...secretNames.map((one) => env[one]), ...tokens.values()].reduce((kept, secret) => (secret ? kept.split(secret).join("[redacted]") : kept), scrubMachineTokens(text));
		const image = typeof module.conformanceImage === "function" ? await module.conformanceImage(options, { signal: controller.signal }) : undefined;
		if (typeof image !== "string" || image === "") throw new Error(`${name}: its conformance module names no image (conformanceImage())`);
		const cases = casesFor(provider.capabilities().kind);
		const fixture = fixtureFor(provider.capabilities().kind);
		if (only !== undefined) {
			// A name that is no group or case id would narrow the run to nothing, which must not read as a pass.
			const known = new Set(cases.flatMap((one) => [one.id, one.group]));
			const unknown = only.filter((one) => !known.has(one));
			if (only.length === 0) throw new Error(`--only names no group or case id\n${USAGE}`);
			if (unknown.length > 0) throw new Error(`--only: ${unknown.join(", ")} is neither a group nor a case id of the provider's suite\n${USAGE}`);
		}
		// Nothing is created until the public address reaches this process: a machine dials it, with a token minted here.
		await reachesThisRun(publicUrl, run, controller.signal);
		const report = await runConformance(provider, {
			image,
			cases,
			...(fixture === undefined ? {} : { fixture }),
			...(only === undefined ? {} : { only }),
			long: true,
			signal: controller.signal,
			dial: () => kit,
			drifted: async () => {
				const arch = provider.host?.facts?.arch ?? "amd64";
				const version = driftedVersion(provider.version);
				if (!drift.copies.has(arch)) drift.copies.set(arch, { ...driftedDaemon(arch, hostedDaemonPath(arch), provider.version, version), version });
				const twin = await module.createProvider({ ...options, dial: { url: publicUrl, tokens: minting(drift.machines), hub }, daemonPath: drift.copies.get(arch).path });
				// The version each of the twin's refused hellos reported, read from the drift check's words: the patched daemon's.
				for (const method of ["create", "connect"]) {
					const call = twin[method].bind(twin);
					twin[method] = async (...args) => {
						const result = await call(...args);
						const said = result?.ok === false ? VERSION_DRIFT.exec(result.error?.message ?? "") : null;
						if (said) drift.hellos.push(said[1]);
						return result;
					};
				}
				return twin;
			},
			...(declared === undefined ? {} : { declared }),
			...(secretNames.length === 0
				? {}
				: {
						planted: async () => {
							const { values, secrets } = plantSecrets(secretNames);
							const planted = { ...env, ...Object.fromEntries(secretNames.map((one, i) => [one, values[i]])) };
							return { provider: await module.createProvider({ ...options, env: planted }), secrets };
						},
					}),
			...(Array.isArray(module.conformanceNotes) ? { notes: module.conformanceNotes } : {}),
			onResult: (result) => say(scrub(`${result.status} ${result.id}${result.reason ? `: ${result.reason}` : ""}`)),
		});
		if (notes.length > 0) report.providerNotes = notes;
		// The daemon copy the drifted twin's machines were served, by its sha256 and the version it reports, and the
		// version their refused hellos reported: drift.version's pass counts only when every one is the copy's.
		const copies = [...drift.copies].map(([arch, { sha256, version }]) => ({ arch, sha256, version }));
		const hellos = [...new Set(drift.hellos)];
		const helloOk = hellos.every((said) => copies.some((copy) => copy.version === said));
		if (copies.length > 0) report.driftedDaemon = { copies, hellos, matches: helloOk };
		if (frames?.png !== undefined) process.stdout.write(`${frameLines(frames.png).join("\n")}\n`);
		process.stdout.write(`${BEGIN}\n${scrub(JSON.stringify(report, null, 2))}\n${END}\n`);
		say(`Core ${report.core}`);
		if (!helloOk) say(`the drifted twin's hellos reported ${hellos.join(", ")}, not the daemon copy's ${copies.map((copy) => copy.version).join(", ")}`);
		// A run --only narrowed is partial at best: it passes when every case it ran passed (the runner's "partial"), and
		// one did.
		const narrowed = only !== undefined && report.core === "partial" && report.results.some((result) => result.status === "pass");
		return (report.core === "pass" || narrowed) && helloOk ? 0 : 1;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await attach.close();
		// Idling, the server stays up and answers /v2/health, so a host that checks it keeps the process as it is.
		if (exit) await new Promise((done) => server.close(() => done()));
	}
}

// Imported (by its test, for patchVersion) rather than run: nothing starts.
if (isMain(import.meta)) {
	const state = { listening: false };
	let args;
	const code = await (async () => {
		args = argsOf(process.argv.slice(2));
		return main(args, process.env, state);
	})().catch((error) => {
		say(error instanceof Error ? error.message : String(error));
		return 1;
	});
	if (args?.exit || !state.listening) {
		process.exitCode = code;
		// The report is written. A provider call the runner stopped waiting for may still hold the event loop: the process
		// ends after a grace period, without holding it open itself.
		setTimeout(() => process.exit(), 5000).unref();
	} else {
		// A host that restarts an exited process (Render's) would start a second run: once a run may have begun, the process
		// idles until it is stopped, and then exits with the run's status.
		say(`the run is over (exit status ${code}); idling until stopped, as a restart would start another run`);
		const end = () => process.exit(code);
		process.once("SIGINT", end);
		process.once("SIGTERM", end);
		setInterval(() => undefined, 2 ** 30);
	}
}
