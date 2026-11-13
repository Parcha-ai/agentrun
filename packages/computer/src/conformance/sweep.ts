// The one live sweep, for every provider on the shared machine-host adapter, with the provider's conformance settings
// (its COMPUTER_<VENDOR>_* names, read by its conformance module's createHost):
//
//   node packages/computer/dist/conformance/sweep.js --provider <id> --before <file>
//   node packages/computer/dist/conformance/sweep.js --provider <id> --after <file>
//
// --before records into <file> the id of every machine the vendor lists with the adapter's label agentrun.computer=1.
// --after lists them again, deletes every one whose id is not in <file> and that carries a conformance run's label
// (agentrun.conformance, RUN_LABEL), then reads each of those back until the vendor no longer has it and no longer lists
// it, up to 60 s each, and prints one JSON line, {"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}: swept is every
// conformance machine it found that was not there before, gone + stillThere.length = swept, and leftAlone counts the new
// labelled machines with no conformance label, which another user of the account made during the run: never touched. A
// machine in <file> is never touched either: no call names it, and a before file of another provider is refused, as is
// one listed elsewhere for a provider whose module names where it lists (sweepScope: an app and a server), since
// every machine there would read as new.
// Exit 0 when every swept machine is gone, 1 when one is still there, 2 on a usage error, a before file it cannot read,
// missing settings, or a listing the vendor refused (nothing is deleted then). It makes nothing, so it needs no live switch.
//
// The conformance runner runs the same sweep (sweepMachines) at the end of every run of a hosted provider, over the
// run's own label: its report's cleanup.sweep, whose stillThere must be empty for Core to pass.
import { readFileSync, writeFileSync } from "node:fs";
import { COMPUTER_LABEL } from "../drift.js";
import { isCommand } from "../entry.js";
import type { MachineHost } from "../host.js";
import { hostCall } from "../hosted/process.js";
import { NAME_LABEL, settleGone } from "../hosted/provider.js";
import { providerModule } from "../providers.js";
import { ok, type Result } from "../result.js";
import { RUN_LABEL } from "./runner.js";

/** What one sweep did: see the file's head. */
export interface SweepCounts {
	swept: number;
	gone: number;
	stillThere: string[];
	leftAlone: number;
}

export interface SweepMachinesOptions {
	/** The labels every machine swept carries, over agentrun.computer=1. */
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
	/** Told, in words, of a machine not deleted or still there. */
	onWords?: (words: string) => void;
}

/**
 * The sweep over host: every machine listed with agentrun.computer=1 and `labels`, not in `before`, that carries a
 * conformance run's label is deleted and read back gone; one without it is left alone and counted. A listing the
 * vendor refused is the error, with nothing deleted.
 */
export async function sweepMachines(host: MachineHost, { labels = {}, before = new Set(), waitMs = 60_000, pollMs = 2_000, requestMs = 30_000, listMs = 60_000, onWords = () => {} }: SweepMachinesOptions = {}): Promise<Result<SweepCounts>> {
	const listed = await hostCall(host, "the listing", (ctx) => host.list({ ...labels, [COMPUTER_LABEL]: "1" }, ctx), listMs);
	if (!listed.ok) return listed;
	const added = listed.value.filter((machine) => !before.has(machine.id));
	// Only a conformance run's machines: one another user of the account made during the run is not this sweep's.
	const fresh = added.filter((machine) => Object.hasOwn(machine.labels, RUN_LABEL));
	const leftAlone = added.length - fresh.length;
	for (const machine of fresh) {
		const deleted = await hostCall(host, `the delete of ${machine.id}`, (ctx) => host.delete(machine.id, ctx), requestMs);
		if (!deleted.ok && deleted.error.code !== "not_found") onWords(`${machine.id} was not deleted: ${deleted.error.message}`);
	}
	// Each read back on its own, at once: gone once the vendor no longer has it and its listing no longer shows it.
	const gone = await Promise.all(
		fresh.map(async (machine) => {
			const name = machine.labels[NAME_LABEL] ?? machine.id;
			const settled = await settleGone(host, { id: machine.id, name }, { requestMs, listMs, pollMs, goneMs: waitMs });
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

const USAGE = `usage: node packages/computer/dist/conformance/sweep.js --provider <id> --before <file> | --after <file>
  --provider <id>  a provider on the shared machine-host adapter (e2b, daytona)
  --before <file>  record the id of every machine the vendor lists with ${COMPUTER_LABEL}=1 into <file>
  --after <file>   delete every machine listed with ${COMPUTER_LABEL}=1 and ${RUN_LABEL} whose id is not in <file>, read
                   each back until the vendor no longer has it (up to 60 s each), and print
                   {"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}; a new one with no ${RUN_LABEL} is left alone
  settings: the provider's conformance module's (COMPUTER_<VENDOR>_*), never the vendor's own names
exit: 0 every swept machine is gone, 1 one is still there, 2 usage error, unreadable before file, no settings, or a refused listing`;

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

/** The ids a before file of this provider (and of this scope, when the provider names one) holds, or why it is not one. */
function beforeIds(file: string, provider: string, scope: string | undefined): Set<string> {
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
	return new Set(ids as string[]);
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
	let before: Set<string> | undefined;
	let host: MachineHost;
	let scope: string | undefined;
	try {
		args = parse(argv);
		const module = io.host === undefined ? await moduleOf(args.provider) : undefined;
		scope = io.host === undefined ? scopeOf(module as HostModule, env) : io.scope;
		if (args.mode === "after") before = beforeIds(args.file, args.provider, scope);
		host = io.host ?? (await (module as HostModule & Required<Pick<HostModule, "createHost">>).createHost({ env }));
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${error instanceof Usage ? `${USAGE}\n` : ""}`);
		return 2;
	}
	if (before === undefined) {
		const listed = await hostCall(host, "the listing", (ctx) => host.list({ [COMPUTER_LABEL]: "1" }, ctx), 60_000);
		if (!listed.ok) {
			await write(stderr, `listing the machines carrying ${COMPUTER_LABEL}=1 failed, so nothing was recorded: ${listed.error.message}\n`);
			return 2;
		}
		const ids = listed.value.map((machine) => machine.id).sort();
		writeFileSync(args.file, `${JSON.stringify({ provider: args.provider, ...(scope === undefined ? {} : { scope }), label: `${COMPUTER_LABEL}=1`, at: new Date().toISOString(), ids }, null, 2)}\n`);
		await write(stdout, `${JSON.stringify({ recorded: ids.length, file: args.file })}\n`);
		return 0;
	}
	const said: string[] = [];
	const swept = await sweepMachines(host, { before, waitMs, pollMs, onWords: (words) => said.push(words) });
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
