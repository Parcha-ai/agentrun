// `npm run conformance -w @parcha/agentrun-computer -- --provider docker | ./module.js [--image <image>] [--only <groups>] [--json]`
// Exits 0 when Core passes, 1 when it fails, 2 on a usage error, and 3 when --only left Core cases out and every case
// that ran passed: a partial run is never a Core pass, so no script reads its exit code as one.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputerProvider } from "../provider.js";
import { conformanceCases } from "./cases/index.js";
import { dockerConformance } from "./docker.js";
import { formatReport } from "./report.js";
import { runConformance } from "./runner.js";
import type { Case, CaseResult } from "./types.js";

/** A stream as main writes to it: done is called once the text is handed on, as Writable.write's callback is. */
export interface Writer {
	write(text: string, done?: (error?: Error | null) => void): unknown;
}

/** Writes text and settles once the stream has taken it, so an exit after it cuts nothing off. */
const write = (stream: Writer, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()));

export interface CliIo {
	stdout?: Writer;
	stderr?: Writer;
	/** Where a module path is resolved from; default the directory npm was run in. */
	cwd?: string;
	cases?: Case[];
	signal?: AbortSignal;
	/** Print each case to stderr as it ends. */
	progress?: boolean;
	/** For --provider docker: the longest `docker version` may take; default 30 s. */
	dockerTimeoutMs?: number;
}

const USAGE = `usage: npm run conformance -w @parcha/agentrun-computer -- --provider docker|<module.js> [--image <image>] [--only <group|case>,...] [--fixture <path>] [--json]
  --provider  docker, or a module that exports createProvider() (and, for the drift case, createDriftedProvider())
  --image     the image every computer starts from (default debian:bookworm-slim)
  --only      run only these groups (health, exec, files, process, provider, drift, screen, input, touch, apps,
              lifetime) or case ids; a run that leaves Core cases out is partial: no Core verdict, and exit 3 when
              every case that ran passed
  --fixture   the fixture the screen, input, touch and apps cases check effects with: computerd-fixture for a
              desktop, the fixture APK for an Android phone
  --json      print the report as JSON
exit: 0 Core passes, 1 it fails, 2 usage error, 3 partial (--only) and every case that ran passed`;
const PROVIDER_METHODS = ["capabilities", "check", "create", "attach", "list", "network", "connect", "release"] as const;

class Usage extends Error {}

interface Args {
	provider: string;
	image: string;
	only?: string[];
	fixture?: string;
	json: boolean;
	help: boolean;
}

function parse(argv: string[], cases: Case[]): Args {
	const args: Partial<Args> & { json: boolean; help: boolean } = { json: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const [flag = "", inline] = (argv[i] ?? "").split(/=(.*)/s, 2);
		const value = () => {
			const given = inline ?? argv[++i];
			if (given === undefined || given === "") throw new Usage(`${flag} needs a value`);
			return given;
		};
		if (flag === "--provider") args.provider = value();
		else if (flag === "--image") args.image = value();
		else if (flag === "--only") args.only = value().split(",").map((part) => part.trim()).filter(Boolean);
		else if (flag === "--fixture") args.fixture = value();
		else if (flag === "--json") args.json = true;
		else if (flag === "--help" || flag === "-h") args.help = true;
		else throw new Usage(`unknown option ${flag}`);
	}
	if (args.help) return { provider: "", image: "", json: false, help: true };
	if (args.provider === undefined) throw new Usage("--provider is required");
	const groups = [...new Set(cases.map((c) => c.group))];
	for (const name of args.only ?? []) {
		if (!groups.includes(name as Case["group"]) && !cases.some((c) => c.id === name)) {
			throw new Usage(`--only: ${name} is neither a group (${groups.join(", ")}) nor a case id`);
		}
	}
	return {
		provider: args.provider,
		image: args.image ?? "debian:bookworm-slim",
		...(args.only ? { only: args.only } : {}),
		...(args.fixture ? { fixture: args.fixture } : {}),
		json: args.json,
		help: false,
	};
}

/** The provider a module makes, and its drifted twin when it offers one. */
async function load(path: string): Promise<{ provider: ComputerProvider; drifted?: () => Promise<ComputerProvider> }> {
	let module: { createProvider?: unknown; createDriftedProvider?: unknown };
	try {
		module = await import(pathToFileURL(path).href);
	} catch (error) {
		throw new Usage(`cannot load the provider module ${path}: ${(error as Error).message.split("\n")[0]}`);
	}
	const { createProvider, createDriftedProvider } = module;
	if (typeof createProvider !== "function") throw new Usage(`${path} does not export createProvider()`);
	const provider = (await createProvider()) as ComputerProvider;
	const lacks = PROVIDER_METHODS.filter((name) => typeof provider?.[name] !== "function");
	if (lacks.length > 0 || typeof provider.id !== "string") {
		throw new Usage(`${path}: createProvider() did not return a ComputerProvider: it lacks ${[...lacks, ...(typeof provider?.id === "string" ? [] : ["id"])].join(", ")}`);
	}
	if (typeof createDriftedProvider !== "function") return { provider };
	return { provider, drifted: async () => (await createDriftedProvider()) as ComputerProvider };
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
	const { stdout = process.stdout, stderr = process.stderr, cases = conformanceCases, signal, progress = false } = io;
	let args: Args;
	try {
		args = parse(argv, cases);
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${USAGE}\n`);
		return 2;
	}
	if (args.help) {
		await write(stdout, `${USAGE}\n`);
		return 0;
	}
	let close = () => {};
	let target: { provider: ComputerProvider; drifted?: () => Promise<ComputerProvider> };
	try {
		if (args.provider === "docker") {
			const docker = dockerConformance(io.dockerTimeoutMs === undefined ? {} : { timeoutMs: io.dockerTimeoutMs });
			target = docker;
			close = docker.close;
		} else {
			target = await load(resolve(io.cwd ?? process.env.INIT_CWD ?? process.cwd(), args.provider));
		}
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n`);
		if (error instanceof Usage) {
			await write(stderr, `${USAGE}\n`);
			return 2;
		}
		return 1;
	}
	try {
		const onResult = progress ? (r: CaseResult) => stderr.write(`${r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "-"} ${r.id}\n`) : undefined;
		const report = await runConformance(target.provider, {
			image: args.image,
			cases,
			...(args.only ? { only: args.only } : {}),
			...(args.fixture ? { fixture: resolve(io.cwd ?? process.env.INIT_CWD ?? process.cwd(), args.fixture) } : {}),
			...(signal ? { signal } : {}),
			...(target.drifted ? { drifted: target.drifted } : {}),
			...(onResult ? { onResult } : {}),
		});
		await write(stdout, args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
		return report.core === "pass" ? 0 : report.core === "partial" ? 3 : 1;
	} finally {
		close();
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.exitCode = await main(process.argv.slice(2), { signal: controller.signal, progress: process.stderr.isTTY === true });
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	// The report is written. Node exits once nothing is left; a provider call the runner stopped waiting for may still
	// hold the event loop, so this ends the process after a grace period, without holding it open itself.
	setTimeout(() => process.exit(), 5000).unref();
}
