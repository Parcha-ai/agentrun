// `npm run conformance -w @parcha/agentrun-computer -- --provider <id> | ./module.js [--image <image>] [--only <groups> | --kind <kind>] [--json]`
// An id is resolved through the provider registry (../providers.ts) and nothing else, so a new computer needs no edit here.
// Exits 0 when Core passes, 1 when it fails, 2 on a usage error, and 3 when --only left Core cases out and every case
// that ran passed: a partial run is never a Core pass, so no script reads its exit code as one. With --kind it exits on
// the kind's verdict alone: 0 when the provider passes the kind, 1 when it does not.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isCommand } from "../entry.js";
import type { ComputerProvider } from "../provider.js";
import { type ConformanceModule, isProviderId, type ProviderEnv, providerIds, providerModule } from "../providers.js";
import { type ComputerSettingKind, SETTING_KIND_NAMES } from "../kinds.js";
import { browserCases, casesFor, conformanceCases } from "./cases/index.js";
import { kindRunProblem } from "./kind.js";
import type { CdpDialer } from "./cdp.js";
import { formatReport } from "./report.js";
import { runConformance } from "./runner.js";
import type { Case, CaseResult, ConformanceOptions } from "./types.js";

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
	/** The cases to run; default the browser case set for a provider of kind browser, else the whole suite. */
	cases?: Case[];
	/** How the browser cases open a CDP socket; default a WebSocket. A test gives a fake browser's. */
	cdp?: CdpDialer;
	signal?: AbortSignal;
	/** Print each case to stderr as it ends. */
	progress?: boolean;
	/**
	 * Given to the module's createProvider(), createDriftedProvider() and conformanceImage(), which may ignore them; its env
	 * is where a conformance module reads its settings (default process.env). A provider file with no conformance module
	 * is given them, but the env, as create()'s options. A test gives a fake SDK or a shorter bound through it.
	 */
	providerOptions?: { env?: ProviderEnv } & Record<string, unknown>;
}

const USAGE = `usage: npm run conformance -w @parcha/agentrun-computer -- --provider ${providerIds.join("|")}|<module.js> [--image <image>] [--only <group|case>,... | --kind <kind>] [--fixture <path>] [--gpu <type>[:<count>]] [--json]
  --provider  a computer in the registry (${providerIds.join(", ")}), or a module path: a provider file that exports
              create(options), or a conformance module that exports createProvider() (and, for the drift case,
              createDriftedProvider(); for the mount cases, mountFor(kind), a fresh run folder for that mount kind)
  --image     the image every computer starts from (default the module's conformanceImage(), else debian:bookworm-slim)
  --only      run only these groups (health, exec, files, process, provider, drift, mount, screen, input, touch,
              apps, lifetime, gpu; browser, run alone for a provider of kind browser) or case ids; a run that leaves Core cases out is partial: no Core verdict, and exit 3 when
              every case that ran passed
  --kind      run a setting kind's cases (sandbox, desktop, phone, browser) and exit on its verdict: the provider passes the kind only
              when it serves it and every case of each required group passes; not with --only
  --fixture   the fixture the screen, input, touch and apps cases check effects with: computerd-fixture for a
              desktop, the fixture APK for an Android phone
  --gpu       the GPU the gpu case's one computer asks for, a type the provider declares and a count (default 1), such
              as T4 or H100:2; it bills by the second, so without it the gpu case skips
  --json      print the report as JSON
exit: 0 Core passes, 1 it fails, 2 usage error, 3 partial (--only) and every case that ran passed; with --kind,
      0 the provider passes the kind, 1 it does not`;
const PROVIDER_METHODS = ["capabilities", "check", "create", "attach", "list", "network", "connect", "release"] as const;

class Usage extends Error {}

interface Args {
	provider: string;
	image?: string;
	only?: string[];
	kind?: ComputerSettingKind;
	fixture?: string;
	gpu?: { type: string; count: number };
	json: boolean;
	help: boolean;
}

/** --gpu's value: a type, then :count (default 1), such as T4 or H100:2; whether the provider offers it is check()'s. */
function gpuOf(text: string): { type: string; count: number } {
	const match = /^([^:\s]+)(?::([1-9][0-9]*))?$/.exec(text);
	if (match === null) throw new Usage(`--gpu: ${JSON.stringify(text)} is not <type>[:<count>], such as T4 or H100:2`);
	return { type: match[1] as string, count: match[2] === undefined ? 1 : Number(match[2]) };
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
		else if (flag === "--kind") {
			const kind = value();
			if (!(SETTING_KIND_NAMES as readonly string[]).includes(kind)) throw new Usage(`--kind: ${JSON.stringify(kind)} is not a kind (${SETTING_KIND_NAMES.join(", ")})`);
			const problem = kindRunProblem(kind as ComputerSettingKind);
			if (problem !== undefined) throw new Usage(`--kind ${kind}: ${problem}`);
			args.kind = kind as ComputerSettingKind;
		} else if (flag === "--fixture") args.fixture = value();
		else if (flag === "--gpu") args.gpu = gpuOf(value());
		else if (flag === "--json") args.json = true;
		else if (flag === "--help" || flag === "-h") args.help = true;
		else throw new Usage(`unknown option ${flag}`);
	}
	if (args.help) return { provider: "", json: false, help: true };
	if (args.provider === undefined) throw new Usage("--provider is required");
	if (args.kind !== undefined && args.only !== undefined) throw new Usage("--kind and --only go apart: a kind runs its own cases");
	const groups = [...new Set(cases.map((c) => c.group))];
	for (const name of args.only ?? []) {
		if (!groups.includes(name as Case["group"]) && !cases.some((c) => c.id === name)) {
			throw new Usage(`--only: ${name} is neither a group (${groups.join(", ")}) nor a case id`);
		}
	}
	return {
		provider: args.provider,
		...(args.image === undefined ? {} : { image: args.image }),
		...(args.only ? { only: args.only } : {}),
		...(args.kind ? { kind: args.kind } : {}),
		...(args.fixture ? { fixture: args.fixture } : {}),
		...(args.gpu ? { gpu: args.gpu } : {}),
		json: args.json,
		help: false,
	};
}

const DEFAULT_IMAGE = "debian:bookworm-slim";

interface Target {
	provider: ComputerProvider;
	drifted?: () => Promise<ComputerProvider>;
	/** The module's run folders for the mount cases: mountFor(kind). */
	mountFor?: ConformanceOptions["mountFor"];
	/** The module's image for a run that names none. */
	image?: string;
	/** The module's notes for the report. */
	notes?: string[];
}

/** A bare name, which is an id; a module path has a slash or an extension. */
// Any bare name, whatever its case: "Docker" is an unknown provider, not a module path.
const BARE = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * The conformance module for --provider: a registry id's provider file, or the module at a path. A provider file's
 * conformance() module is run when it has one, else its create() alone, given the CLI's options but the env (a provider
 * reads no environment), with no drifted twin.
 */
async function conformanceModule(name: string, cwd: string): Promise<{ label: string; module: Partial<ConformanceModule> }> {
	let label = name;
	let module: Record<string, unknown>;
	if (isProviderId(name)) {
		module = { ...(await providerModule(name)) };
	} else if (BARE.test(name)) {
		throw new Usage(`unknown computer provider ${JSON.stringify(name)}: the registry holds ${providerIds.join(", ")}; or give a module path, such as ./my-provider.js`);
	} else {
		label = resolve(cwd, name);
		try {
			module = await import(pathToFileURL(label).href);
		} catch (error) {
			throw new Usage(`cannot load the provider module ${label}: ${(error as Error).message.split("\n")[0]}`);
		}
	}
	if (typeof module.conformance === "function") return { label, module: await module.conformance() };
	if (typeof module.createProvider !== "function" && typeof module.create === "function") {
		const create = module.create as (options: object) => ComputerProvider | Promise<ComputerProvider>;
		return {
			label,
			module: {
				createProvider: (options: object = {}) => {
					const { env: _env, ...rest } = options as { env?: ProviderEnv };
					return create(rest);
				},
			},
		};
	}
	return { label, module: module as Partial<ConformanceModule> };
}

/**
 * The provider a conformance module makes, its drifted twin and its run folders (mountFor) when it offers them, and what
 * it says of its run: conformanceImage(), the image when --image names none, and conformanceNotes, strings for the report.
 */
async function load(label: string, module: Partial<ConformanceModule>, options: object): Promise<Target> {
	const { createProvider, createDriftedProvider, conformanceImage, mountFor } = module;
	if (typeof createProvider !== "function") throw new Usage(`${label} does not export createProvider() or create()`);
	const provider = (await createProvider(options)) as ComputerProvider;
	const lacks = PROVIDER_METHODS.filter((name) => typeof provider?.[name] !== "function");
	if (lacks.length > 0 || typeof provider.id !== "string") {
		throw new Usage(`${label}: createProvider() did not return a ComputerProvider: it lacks ${[...lacks, ...(typeof provider?.id === "string" ? [] : ["id"])].join(", ")}`);
	}
	const target: Target = { provider };
	if (typeof createDriftedProvider === "function") target.drifted = async () => (await createDriftedProvider(options)) as ComputerProvider;
	if (typeof mountFor === "function") target.mountFor = (kind) => mountFor(kind, options);
	if (conformanceImage !== undefined) {
		const image = typeof conformanceImage === "function" ? await conformanceImage(options) : undefined;
		if (typeof image !== "string" || image === "") throw new Usage(`${label}: conformanceImage() did not return an image`);
		target.image = image;
	}
	const notes: unknown = module.conformanceNotes;
	if (notes !== undefined) {
		if (!Array.isArray(notes) || !notes.every((note) => typeof note === "string")) throw new Usage(`${label}: conformanceNotes is not an array of strings`);
		target.notes = notes;
	}
	return target;
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
	const { stdout = process.stdout, stderr = process.stderr, signal, progress = false } = io;
	let args: Args;
	try {
		// --only is read against every case either set holds; the set itself is chosen once the provider says its kind.
		args = parse(argv, io.cases ?? [...conformanceCases, ...browserCases.filter((c) => !conformanceCases.includes(c))]);
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${USAGE}\n`);
		return 2;
	}
	if (args.help) {
		await write(stdout, `${USAGE}\n`);
		return 0;
	}
	const cwd = io.cwd ?? process.env.INIT_CWD ?? process.cwd();
	// What the provider says that is no failure (onNote, as each remote provider takes it) goes in the report.
	const providerNotes: Array<{ computer: string; note: string }> = [];
	const options = { ...(io.providerOptions ?? {}), onNote: (note: { computer: string; note: string }) => providerNotes.push({ computer: note.computer, note: note.note }) };
	let target: Target;
	try {
		const { label, module } = await conformanceModule(args.provider, cwd);
		target = await load(label, module, options);
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n`);
		if (error instanceof Usage) {
			await write(stderr, `${USAGE}\n`);
			return 2;
		}
		return 1;
	}
	const cases = io.cases ?? casesFor(target.provider.capabilities().kind);
	const onResult = progress ? (r: CaseResult) => stderr.write(`${r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "-"} ${r.id}\n`) : undefined;
	const report = await runConformance(target.provider, {
		image: args.image ?? target.image ?? DEFAULT_IMAGE,
		...(target.notes && target.notes.length > 0 ? { notes: target.notes } : {}),
		cases,
		...(args.only ? { only: args.only } : {}),
		...(args.kind ? { kind: args.kind } : {}),
		...(args.fixture ? { fixture: resolve(cwd, args.fixture) } : {}),
		...(args.gpu ? { gpu: args.gpu } : {}),
		...(signal ? { signal } : {}),
		...(target.drifted ? { drifted: target.drifted } : {}),
		...(target.mountFor ? { mountFor: target.mountFor } : {}),
		...(onResult ? { onResult } : {}),
		...(io.cdp ? { cdp: io.cdp } : {}),
	});
	if (providerNotes.length > 0) report.providerNotes = providerNotes;
	await write(stdout, args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
	if (report.kindVerdict) return report.kindVerdict.verdict === "pass" ? 0 : 1;
	return report.core === "pass" ? 0 : report.core === "partial" ? 3 : 1;
}

if (isCommand(import.meta)) {
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
