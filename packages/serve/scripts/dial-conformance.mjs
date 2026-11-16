#!/usr/bin/env node
// The computer conformance suite's Core, with --long, for a provider whose machines dial the server (facts.connect
// "dial", such as Fly Machines): the run happens inside the server its machines reach. It stands up serve's own attach
// routes (createAttachRoutes: the minted tokens, the attach socket's upgrade and the daemon route) over a store in memory,
// on an HTTP server bound to $PORT that answers GET /v2/health 200, and builds the provider with the dial that server
// gives: AGENTRUN_PUBLIC_URL, the tokens it mints and its attach hub. Then it runs Core, provider.deadline and drift.arch
// among it, and prints the report as JSON between two marker lines, DIAL-CONFORMANCE-REPORT-BEGIN and
// DIAL-CONFORMANCE-REPORT-END, so a log that holds other lines still yields it. It exits 0 when Core passes, else 1.
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
// another version, so the drifted twin's machines are served a copy of the daemon with its version string changed in
// place (same length): the copy's sha256 is the twin's, and only the twin's tokens are served it.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACH_HELLO_MS, ATTACH_PATH, ATTACH_SUBPROTOCOL, AttachHub, DAEMON_PATH, descriptorOf, hostedDaemonPath, isProviderId, providerModule } from "@parcha/agentrun-computer";
import WebSocket from "ws";
import { plantSecrets } from "../../computer/dist/conformance/cli.js";
import { casesFor, runConformance } from "../../computer/dist/conformance/index.js";
import { createAttachRoutes, sha256Hex } from "../dist/computer-attach.js";

const BEGIN = "DIAL-CONFORMANCE-REPORT-BEGIN";
const END = "DIAL-CONFORMANCE-REPORT-END";
const USAGE = "usage: node dial-conformance.mjs --provider <registry id or module path> [--only <groups and case ids>], with AGENTRUN_PUBLIC_URL and PORT set";
/** A name of a module's ENV that holds a secret (the conformance CLI's rule). */
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET)(_|$)/;
/** A token serve mints for a machine (computer-attach.ts newMintedToken). */
const MINTED_TOKEN = /art_[0-9a-f]{64}/g;

const say = (line) => process.stderr.write(`dial-conformance: ${line}\n`);

/** --provider's value, and --only's groups and case ids when it is given; anything else is a usage error. */
function argsOf(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const [flag, value] = [argv[i], argv[i + 1]];
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
		async mint({ machine, tokenSha256, kind, os, arch, expiresAt }) {
			prune();
			rows.set(machine, { machine, tokenSha256, kind, os, arch, expiresAt, revokedAt: null, createdAt: now() });
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

/** The version a drifted daemon reports: the provider's, its last character changed, so the bytes keep their length. */
const driftedVersion = (version) => `${version.slice(0, -1)}${version.endsWith("x") ? "y" : "x"}`;

/** Go's name for this process's architecture: the daemon builds this machine can run. */
const HERE = { x64: "amd64", arm64: "arm64" }[process.arch];

/**
 * A copy of the daemon for `arch` at `path` in a directory of its own, every `from` in it written over with `to`; its
 * path. A copy this machine can run is run once (`computerd version`), and must say `to`: one that does not start, or
 * says another version, fails the drift case here rather than in a machine.
 */
function driftedDaemon(arch, path, from, to) {
	const bytes = readFileSync(path);
	const was = Buffer.from(from);
	let found = 0;
	for (let at = bytes.indexOf(was); at !== -1; at = bytes.indexOf(was, at + was.length)) {
		Buffer.from(to).copy(bytes, at);
		found++;
	}
	if (found === 0) throw new Error(`the daemon at ${path} holds no version string ${from} to change for the drift case`);
	const dir = mkdtempSync(join(tmpdir(), "dial-conformance-drift-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	const out = join(dir, "computerd");
	writeFileSync(out, bytes);
	chmodSync(out, 0o755);
	if (arch === HERE) {
		const said = execFileSync(out, ["version"], { encoding: "utf8", env: {}, timeout: 10_000 }).trim();
		if (said !== to) throw new Error(`the drift case's copy of ${path} says version ${said}, not ${to}`);
	}
	return out;
}

/** A JSON answer. */
function answer(res, status, body, headers = {}) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), "cache-control": "no-store", ...headers });
	res.end(text);
}

async function main(argv, env) {
	const { provider: name, only } = argsOf(argv);
	const publicUrl = env.AGENTRUN_PUBLIC_URL;
	if (!publicUrl) throw new Error(`AGENTRUN_PUBLIC_URL is not set: the provider's machines dial it, so it is the https address the internet reaches this process at\n${USAGE}`);
	const port = Number(env.PORT);
	if (!env.PORT || !Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`PORT is the port this process listens on, not ${JSON.stringify(env.PORT ?? "")}\n${USAGE}`);
	const { module, declared } = await moduleOf(name);

	const store = memoryMintedTokens();
	const hub = new AttachHub();
	const attach = createAttachRoutes({
		store: { pairedComputers: NO_PAIRING, mintedTokens: store },
		hub,
		machinesOnly: true,
		log: (event, fields) => say(`${event} ${JSON.stringify(fields)}`),
	});
	/** Each machine's token, by its name (DialKit.token), and the drifted twin's machines with the daemon copy they are served. */
	const tokens = new Map();
	const drift = { machines: new Set(), paths: new Map() };
	const minting = (into) => ({
		async mint(machine, mint) {
			const token = await attach.machineTokens.mint(machine, mint);
			tokens.set(machine, token);
			into?.add(machine);
			return token;
		},
		revoke: (machine) => attach.machineTokens.revoke(machine),
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
			if (req.method === "GET" && path === "/v2/health") return answer(res, 200, { status: "ok" });
			if ((req.method === "GET" || req.method === "HEAD") && path === DAEMON_PATH) {
				const arch = query.get("arch");
				const file = await attach.daemon(req.headers.authorization, arch);
				const machine = await machineOf(req.headers.authorization);
				const bytes = await readFile(drift.machines.has(machine) ? (drift.paths.get(arch) ?? file) : file);
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
		const scrub = (text) => [...secretNames.map((one) => env[one]), ...tokens.values()].reduce((kept, secret) => (secret ? kept.split(secret).join("[redacted]") : kept), text.replace(MINTED_TOKEN, "art_[redacted]"));
		const image = typeof module.conformanceImage === "function" ? await module.conformanceImage(options, { signal: controller.signal }) : undefined;
		if (typeof image !== "string" || image === "") throw new Error(`${name}: its conformance module names no image (conformanceImage())`);
		const cases = casesFor(provider.capabilities().kind);
		if (only !== undefined) {
			// A name that is no group or case id would narrow the run to nothing, which must not read as a pass.
			const known = new Set(cases.flatMap((one) => [one.id, one.group]));
			const unknown = only.filter((one) => !known.has(one));
			if (only.length === 0) throw new Error(`--only names no group or case id\n${USAGE}`);
			if (unknown.length > 0) throw new Error(`--only: ${unknown.join(", ")} is neither a group nor a case id of the provider's suite\n${USAGE}`);
		}
		const report = await runConformance(provider, {
			image,
			cases,
			...(only === undefined ? {} : { only }),
			long: true,
			signal: controller.signal,
			dial: () => kit,
			drifted: async () => {
				const arch = provider.host?.facts?.arch ?? "amd64";
				if (!drift.paths.has(arch)) drift.paths.set(arch, driftedDaemon(arch, hostedDaemonPath(arch), provider.version, driftedVersion(provider.version)));
				return module.createProvider({ ...options, dial: { url: publicUrl, tokens: minting(drift.machines), hub }, daemonPath: drift.paths.get(arch) });
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
		process.stdout.write(`${BEGIN}\n${scrub(JSON.stringify(report, null, 2))}\n${END}\n`);
		say(`Core ${report.core}`);
		// A run --only narrowed is partial at best: it passes when every case it ran passed (the runner's "partial"), and
		// one did.
		const narrowed = only !== undefined && report.core === "partial" && report.results.some((result) => result.status === "pass");
		return report.core === "pass" || narrowed ? 0 : 1;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await attach.close();
		await new Promise((done) => server.close(() => done()));
	}
}

process.exitCode = await main(process.argv.slice(2), process.env).catch((error) => {
	say(error instanceof Error ? error.message : String(error));
	return 1;
});
// The report is written. A provider call the runner stopped waiting for may still hold the event loop: the process ends
// after a grace period, without holding it open itself.
setTimeout(() => process.exit(), 5000).unref();
