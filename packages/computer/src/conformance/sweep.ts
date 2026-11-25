// The one live sweep, for every provider on the shared machine-host adapter, with the provider's conformance settings
// (its COMPUTER_<VENDOR>_* names, read by its conformance module's createHost):
//
//   node packages/computer/dist/conformance/sweep.js --provider <id> --before <file>
//   node packages/computer/dist/conformance/sweep.js --provider <id> --after <file>
//
// --before records into <file> the id of every machine the vendor lists with the adapter's label agentrun.computer=1,
// and a run id it mints for the run it wraps, which it prints: {"recorded":n,"file":...,"run":"<id>"}. The run is given
// that id with the conformance CLI's --run (runConformance's run), and every machine it makes carries it as
// agentrun.conformance (RUN_LABEL). <file> must not be there yet: --before makes it, and refuses one that is, with
// nothing listed, since another run's --after may read it (each run takes its own, from mktemp -d).
// --after lists them again, deletes every one whose id is not in <file> and whose RUN_LABEL is the file's run, then
// reads each of those back by get until the vendor no longer has it, up to 60 s each, and prints one JSON line,
// {"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}: swept is every machine of the run it found that was not there
// before, gone + stillThere.length = swept, and leftAlone counts the other new labelled machines, which another user of
// the account or another conformance run made during the run: never touched. A machine in <file> is never touched
// either: no call names it, and a before file of another provider is refused, as is one that names no run, and one
// listed elsewhere for a provider whose module names where it lists (sweepScope: an app and a server), since every
// machine there would read as new.
// Exit 0 when every swept machine is gone, 1 when one is still there, 2 on a usage error, a before file it cannot read
// (or, for --before, one that is there already), missing settings, or a listing the vendor refused (nothing is deleted
// then). It makes nothing, so it needs no live switch.
//
// The conformance runner runs the same sweep (sweepMachines) at the end of every run of a hosted provider, over its own
// labels, the run's and the runner's (RUNNER_LABEL): its report's cleanup.sweep, whose stillThere must be empty for Core
// to pass.
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { COMPUTER_LABEL } from "../drift.js";
import { isCommand } from "../entry.js";
import type { MachineHost } from "../host.js";
import { hostCall } from "../hosted/process.js";
import { foundBy, listedBy, NAME_LABEL, settle } from "../hosted/provider.js";
import { providerIds, providerModule } from "../providers.js";
import { fail, ok, type Result } from "../result.js";
import { newRunId, RUN_ID, RUN_LABEL } from "./runner.js";

/** What one sweep did: see the file's head. */
export interface SweepCounts {
	swept: number;
	gone: number;
	stillThere: string[];
	leftAlone: number;
}

export interface SweepMachinesOptions {
	/** The conformance run whose machines are deleted: those whose RUN_LABEL is this id. */
	run: string;
	/** The labels the listing asks for, over agentrun.computer=1. */
	labels?: Record<string, string>;
	/** Ids that were there before: never touched. */
	before?: ReadonlySet<string>;
	/** How long one deleted machine is read back before it counts as still there; default 60 s. */
	waitMs?: number;
	/** The pause between two reads of one machine; default 2 s. */
	pollMs?: number;
	/** One vendor call's bound; default 30 s. */
	requestMs?: number;
	/** One whole listing's bound; default 60 s. */
	listMs?: number;
	/** Told, in words, of a machine not read, not deleted or still there. */
	onWords?: (words: string) => void;
}

/**
 * The sweep over host: every machine listed with agentrun.computer=1 and `labels`, not in `before`, whose RUN_LABEL is
 * `run` is deleted and read back gone; any other is left alone and counted. A listing the vendor refused is the error,
 * with nothing deleted, as is a run that is not a run id: nothing is listed then.
 */
export async function sweepMachines(host: MachineHost, { run, labels = {}, before = new Set(), waitMs = 60_000, pollMs = 2_000, requestMs = 30_000, listMs = 60_000, onWords = () => {} }: SweepMachinesOptions): Promise<Result<SweepCounts>> {
	// A caller with no run (undefined) would otherwise match every machine that carries no run label.
	if (typeof run !== "string" || !RUN_ID.test(run)) return fail("invalid", `run is a conformance run's id, 12 hex characters; got ${JSON.stringify(run)}`);
	const listed = await foundBy(host, "the listing", { ...labels, [COMPUTER_LABEL]: "1" }, { listMs, requestMs });
	if (!listed.ok) return listed;
	const added = listed.value.filter((machine) => !before.has(machine.id));
	// Only this run's machines: one another user of the account, or another conformance run, made meanwhile is not its.
	const fresh = added.filter((machine) => machine.labels[RUN_LABEL] === run);
	const leftAlone = added.length - fresh.length;
	for (const machine of fresh) {
		const deleted = await hostCall(host, `the delete of ${machine.id}`, (ctx) => host.delete(machine.id, ctx), requestMs);
		if (!deleted.ok && deleted.error.code !== "not_found") onWords(`${machine.id} was not deleted: ${deleted.error.message}`);
	}
	// Each read back on its own, at once: gone once get reads it gone (settle).
	const gone = await Promise.all(
		fresh.map(async (machine) => {
			const name = machine.labels[NAME_LABEL] ?? machine.id;
			const settled = await settle(host, { id: machine.id, name }, { requestMs, pollMs, goneMs: waitMs });
			if (!settled.ok) onWords(`${machine.id} is still there after ${waitMs / 1000} s: ${settled.error.message}`);
			return settled.ok;
		}),
	);
	const stillThere = fresh.filter((_, i) => !gone[i]).map((machine) => machine.id);
	return ok({ swept: fresh.length, gone: fresh.length - stillThere.length, stillThere, leftAlone });
}

/** A stream as main writes to it: done is called once the text is handed on. */
export interface Writer {
	write(text: string, done?: (error?: Error | null) => void): unknown;
}

export interface SweepIo {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** The host to sweep, in place of the one the provider's conformance module makes from env. */
	host?: MachineHost;
	/** Where that host lists, in words, in place of the module's sweepScope. */
	scope?: string;
	stdout?: Writer;
	stderr?: Writer;
	/** How long --after reads one deleted machine back before it counts as still there; default 60 s. */
	waitMs?: number;
	/** The pause between two reads of one machine; default 2 s. */
	pollMs?: number;
}

/** A hosted provider's conformance module: it makes the host from its own settings, with no live switch. */
interface HostModule {
	createHost?(options: { env?: Record<string, string | undefined> }): Promise<MachineHost>;
	/** Where the host lists, in words, when one account holds more than one place (an app, a server). */
	sweepScope?(options: { env?: Record<string, string | undefined> }): string;
}

/** The registry's providers on the shared machine-host adapter, in its order: each whose conformance module has
 *  createHost (what moduleOf asks of one). Read from the modules, so a provider added there is listed with no edit. */
export async function sweepableProviders(): Promise<string[]> {
	const ids: string[] = [];
	for (const id of providerIds) {
		const module = (await providerModule(id)
			.then((one) => one.conformance?.())
			.catch(() => undefined)) as HostModule | undefined;
		if (typeof module?.createHost === "function") ids.push(id);
	}
	return ids;
}

const usage = async () => `usage: node packages/computer/dist/conformance/sweep.js --provider <id> --before <file> | --after <file>
  --provider <id>  a provider on the shared machine-host adapter (${(await sweepableProviders()).join(", ")})
  --before <file>  record the id of every machine the vendor lists with ${COMPUTER_LABEL}=1 into <file>, with a run id
                   it mints and prints ({"recorded":n,"file":...,"run":"<id>"}): give it to the run's --run.
                   <file> must not be there yet (each run its own, from mktemp -d): an existing one is refused
  --after <file>   delete every machine listed with ${COMPUTER_LABEL}=1 whose id is not in <file> and whose ${RUN_LABEL}
                   is <file>'s run, read each back until the vendor no longer has it (up to 60 s each), and print
                   {"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}; any other new one is left alone
  settings: the provider's conformance module's (COMPUTER_<VENDOR>_*), never the vendor's own names
exit: 0 every swept machine is gone, 1 one is still there, 2 usage error, unreadable before file, a --before file there
      already, no settings, or a refused listing`;

class Usage extends Error {}

const write = (stream: Writer, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()));

interface Args {
	provider: string;
	mode: "before" | "after";
	file: string;
}

function parse(argv: string[]): Args {
	let provider: string | undefined;
	let found: { mode: "before" | "after"; file: string } | undefined;
	for (let i = 0; i < argv.length; i++) {
		const [flag = "", inline] = (argv[i] ?? "").split(/=(.*)/s, 2);
		if (flag !== "--before" && flag !== "--after" && flag !== "--provider") throw new Usage(`unknown option ${flag}`);
		const value = inline ?? argv[++i];
		if (value === undefined || value === "" || value.startsWith("--")) throw new Usage(`${flag} needs a ${flag === "--provider" ? "provider id" : "file"}`);
		if (flag === "--provider") {
			if (provider !== undefined) throw new Usage("give --provider once");
			provider = value;
			continue;
		}
		if (found !== undefined) throw new Usage("give --before <file> or --after <file>, one of them");
		found = { mode: flag === "--before" ? "before" : "after", file: value };
	}
	if (provider === undefined) throw new Usage("give --provider <id>");
	if (found === undefined) throw new Usage("give --before <file> or --after <file>, one of them");
	return { provider, ...found };
}

/**
 * The ids a before file of this provider (and of this scope, when the provider names one) holds and the run it minted,
 * or why it is not one.
 */
function beforeOf(file: string, provider: string, scope: string | undefined): { ids: Set<string>; run: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new Usage(`cannot read the before file ${file}: ${(error as Error).message}`);
	}
	let record: unknown;
	try {
		record = JSON.parse(text);
	} catch {
		record = undefined;
	}
	const { ids, provider: recorded } = (record ?? {}) as { ids?: unknown; provider?: unknown };
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id !== "")) throw new Usage(`${file} is not a before file: it holds no "ids" array of machine ids`);
	if (recorded !== provider) throw new Usage(`${file} is the before file of ${JSON.stringify(recorded)}, not of ${provider}: sweep each provider with its own`);
	const listed = (record as { scope?: unknown }).scope;
	if (scope !== undefined && listed !== scope) {
		const words = typeof listed === "string" && listed !== "" ? `was listed in ${listed}` : "names no place it was listed in";
		throw new Usage(`${file} ${words}, and the settings name ${scope} now: every machine there would read as new, so nothing was listed or deleted`);
	}
	const run = (record as { run?: unknown }).run;
	if (typeof run !== "string" || !RUN_ID.test(run)) {
		throw new Usage(`${file} names no conformance run ("run", 12 hex characters): record it again with --before, and give the run it prints to the conformance CLI's --run; nothing was listed or deleted`);
	}
	return { ids: new Set(ids as string[]), run };
}

/** The provider's conformance module, for its host and scope. */
async function moduleOf(provider: string): Promise<HostModule> {
	let module: HostModule;
	try {
		module = (await (await providerModule(provider)).conformance?.()) as HostModule;
	} catch (error) {
		throw new Usage((error as Error).message);
	}
	if (typeof module?.createHost !== "function") throw new Usage(`the ${provider} provider is not on the shared machine-host adapter: it has no createHost to sweep with`);
	return module;
}

/** Where the module's host lists, in words, read from the same settings; undefined for a provider that names none. */
function scopeOf(module: HostModule, env: Record<string, string | undefined>): string | undefined {
	try {
		return module.sweepScope?.({ env });
	} catch (error) {
		throw new Usage((error as Error).message);
	}
}

export async function main(argv: string[], io: SweepIo = {}): Promise<number> {
	const { env = process.env, stdout = process.stdout, stderr = process.stderr, waitMs = 60_000, pollMs = 2_000 } = io;
	let args: Args;
	let before: { ids: Set<string>; run: string } | undefined;
	let host: MachineHost;
	let scope: string | undefined;
	try {
		args = parse(argv);
		const module = io.host === undefined ? await moduleOf(args.provider) : undefined;
		scope = io.host === undefined ? scopeOf(module as HostModule, env) : io.scope;
		if (args.mode === "after") before = beforeOf(args.file, args.provider, scope);
		host = io.host ?? (await (module as HostModule & Required<Pick<HostModule, "createHost">>).createHost({ env }));
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${error instanceof Usage ? `${await usage()}\n` : ""}`);
		return 2;
	}
	if (before === undefined) {
		// The file is made here, before the listing, and only if it is not there ("wx"): a before file another run
		// recorded is never written over, or that run's --after would read this run's id and delete this run's machines.
		let fd: number;
		try {
			fd = openSync(args.file, "wx");
		} catch (error) {
			const why = (error as NodeJS.ErrnoException).code === "EEXIST" ? "is there already, and --before never writes over a before file: another run's --after may read it. Give each run a file of its own (mktemp -d)" : `cannot be made: ${(error as Error).message}`;
			await write(stderr, `${args.file} ${why}; nothing was listed\n`);
			return 2;
		}
		const listed = await listedBy(host, "the listing", { [COMPUTER_LABEL]: "1" }, 60_000);
		if (!listed.ok) {
			// The empty file this --before made goes, so the same path takes the next one.
			closeSync(fd);
			rmSync(args.file, { force: true });
			await write(stderr, `listing the machines carrying ${COMPUTER_LABEL}=1 failed, so nothing was recorded: ${listed.error.message}\n`);
			return 2;
		}
		const ids = listed.value.map((machine) => machine.id).sort();
		// The run this sweep wraps: its --after deletes only the machines labelled with this id, never another run's.
		const run = newRunId();
		try {
			writeFileSync(fd, `${JSON.stringify({ provider: args.provider, ...(scope === undefined ? {} : { scope }), label: `${COMPUTER_LABEL}=1`, run, at: new Date().toISOString(), ids }, null, 2)}\n`);
		} finally {
			closeSync(fd);
		}
		await write(stdout, `${JSON.stringify({ recorded: ids.length, file: args.file, run })}\n`);
		return 0;
	}
	const said: string[] = [];
	const swept = await sweepMachines(host, { run: before.run, before: before.ids, waitMs, pollMs, onWords: (words) => said.push(words) });
	for (const words of said) await write(stderr, `${words}\n`);
	if (!swept.ok) {
		await write(stderr, `listing the machines carrying ${COMPUTER_LABEL}=1 failed, so nothing was deleted: ${swept.error.message}\n`);
		return 2;
	}
	await write(stdout, `${JSON.stringify(swept.value)}\n`);
	return swept.value.stillThere.length === 0 ? 0 : 1;
}

if (isCommand(import.meta)) {
	process.exitCode = await main(process.argv.slice(2));
}
