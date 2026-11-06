// The sweep around a live Daytona run, with the conformance module's settings (COMPUTER_DAYTONA_*, never DAYTONA_*):
//
//   node packages/computer/dist/conformance/daytona-sweep.js --before <file>
//   node packages/computer/dist/conformance/daytona-sweep.js --after <file>
//
// --before records the id of every sandbox carrying agentrun.computer=1 into <file>. --after lists them again, deletes
// (release delete) every one whose id is not in <file>, then reads each of those back with GET /sandbox/{id} until
// Daytona answers 404, up to 60 s each, and prints one JSON line, {"swept":n,"notFound":m,"stillThere":[ids]}: swept is
// every sandbox it found that was not there before, and notFound + stillThere.length = swept. A sandbox in <file> is
// never touched: no call names it. Exit 0 when every swept sandbox reads back 404, 1 when one is still there, 2 on a
// usage error, a before file it cannot read, a missing key or a listing Daytona refused (nothing is deleted then).
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { DaytonaProviderOptions } from "../daytona.js";
import { COMPUTER_LABEL } from "../drift.js";
import { createProvider } from "./daytona.js";

/** A stream as main writes to it: done is called once the text is handed on. */
export interface Writer {
	write(text: string, done?: (error?: Error | null) => void): unknown;
}

export interface SweepIo {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	fetch?: DaytonaProviderOptions["fetch"];
	webSocket?: DaytonaProviderOptions["webSocket"];
	stdout?: Writer;
	stderr?: Writer;
	/** How long --after reads one deleted sandbox back before it counts as still there; default 60 s. */
	waitMs?: number;
	/** The pause between two reads of one sandbox; default 2 s. */
	pollMs?: number;
}

const USAGE = `usage: node packages/computer/dist/conformance/daytona-sweep.js --before <file> | --after <file>
  --before <file>  record the id of every sandbox carrying ${COMPUTER_LABEL}=1 into <file>
  --after <file>   delete every sandbox carrying ${COMPUTER_LABEL}=1 whose id is not in <file>, read each back until
                   Daytona answers 404 (up to 60 s each), and print {"swept":n,"notFound":m,"stillThere":[ids]}
  settings: COMPUTER_DAYTONA_API_KEY (required) and COMPUTER_DAYTONA_API_URL, as the conformance module reads them
exit: 0 every swept sandbox is gone, 1 one is still there, 2 usage error, unreadable before file, no key, or a refused listing`;

class Usage extends Error {}

const write = (stream: Writer, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parse(argv: string[]): { mode: "before" | "after"; file: string } {
	let found: { mode: "before" | "after"; file: string } | undefined;
	for (let i = 0; i < argv.length; i++) {
		const [flag = "", inline] = (argv[i] ?? "").split(/=(.*)/s, 2);
		if (flag !== "--before" && flag !== "--after") throw new Usage(`unknown option ${flag}`);
		const file = inline ?? argv[++i];
		if (file === undefined || file === "" || file.startsWith("--")) throw new Usage(`${flag} needs a file`);
		if (found !== undefined) throw new Usage("give --before <file> or --after <file>, one of them");
		found = { mode: flag === "--before" ? "before" : "after", file };
	}
	if (found === undefined) throw new Usage("give --before <file> or --after <file>, one of them");
	return found;
}

/** The ids a before file holds, or why it is not one. */
function beforeIds(file: string): Set<string> {
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
	const ids = (record as { ids?: unknown } | null | undefined)?.ids;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id !== "")) throw new Usage(`${file} is not a before file: it holds no "ids" array of sandbox ids`);
	return new Set(ids as string[]);
}

export async function main(argv: string[], io: SweepIo = {}): Promise<number> {
	const { env = process.env, stdout = process.stdout, stderr = process.stderr, waitMs = 60_000, pollMs = 2_000 } = io;
	let args: { mode: "before" | "after"; file: string };
	let before: Set<string> | undefined;
	let provider: ReturnType<typeof createProvider>;
	try {
		args = parse(argv);
		if (args.mode === "after") before = beforeIds(args.file);
		provider = createProvider({ env, ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.webSocket ? { webSocket: io.webSocket } : {}) });
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${error instanceof Usage ? `${USAGE}\n` : ""}`);
		return 2;
	}
	const listed = await provider.listLabelled();
	if (!listed.ok) {
		await write(stderr, `listing the sandboxes carrying ${COMPUTER_LABEL}=1 failed, so nothing was ${args.mode === "after" ? "deleted" : "recorded"}: ${listed.error.message}\n`);
		return 2;
	}
	if (before === undefined) {
		const ids = [...new Set(listed.value.map((sb) => sb.id))].sort();
		writeFileSync(args.file, `${JSON.stringify({ label: `${COMPUTER_LABEL}=1`, at: new Date().toISOString(), ids }, null, 2)}\n`);
		await write(stdout, `${JSON.stringify({ recorded: ids.length, file: args.file })}\n`);
		return 0;
	}
	const known = before;
	const fresh = [...new Map(listed.value.filter((sb) => !known.has(sb.id)).map((sb) => [sb.id, sb])).values()];
	for (const sb of fresh) {
		const released = await provider.release({ id: sb.id, name: sb.name ?? "" }, "delete");
		if (!released.ok) await write(stderr, `${sb.id} (${sb.name ?? "no name"}) was not deleted: ${released.error.message}\n`);
	}
	// Each one read back on its own, at once: a 404 is gone; anything else, or no answer, is read again until its wait ends.
	const gone = await Promise.all(
		fresh.map(async (sb) => {
			const end = Date.now() + waitMs;
			for (;;) {
				const read = await provider.probe(sb.id);
				if (read.ok && read.value.status === 404) return true;
				if (Date.now() >= end) {
					const last = read.ok ? `${read.value.status}${read.value.state ? ` (${read.value.state})` : ""}` : read.error.message;
					await write(stderr, `${sb.id} is still there after ${waitMs / 1000} s: GET /sandbox/${sb.id} answered ${last}\n`);
					return false;
				}
				await sleep(pollMs);
			}
		}),
	);
	const stillThere = fresh.filter((_, i) => !gone[i]).map((sb) => sb.id);
	await write(stdout, `${JSON.stringify({ swept: fresh.length, notFound: fresh.length - stillThere.length, stillThere })}\n`);
	return stillThere.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
