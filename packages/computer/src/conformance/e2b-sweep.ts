// The sweep around a live E2B run, with the provider's settings (COMPUTER_E2B_*, never E2B_*):
//
//   node packages/computer/dist/conformance/e2b-sweep.js --before <file>
//   node packages/computer/dist/conformance/e2b-sweep.js --after <file>
//
// --before records into <file> the id of every sandbox E2B lists with the provider's label agentrun.computer=1
// (Sandbox.list with that metadata, running and paused ones: e2b@2.63.0 dist/index.mjs:5974-5986, 5793-5835). --after
// lists them again, kills (Sandbox.kill) every one whose id is not in <file>, then reads each of those back with getInfo
// until E2B no longer has it (SandboxNotFoundError, index.mjs:5431) and no longer lists it, up to 60 s each, and prints
// one JSON line, {"swept":n,"gone":m,"stillThere":[ids]}: swept is every labelled sandbox it found that was not there
// before, and gone + stillThere.length = swept. A sandbox in <file> is never touched: no call names it. Exit 0 when
// every swept sandbox is gone, 1 when one is still there, 2 on a usage error, a before file it cannot read, a missing
// key, or a listing E2B refused (nothing is killed then).
//
// It reads COMPUTER_E2B_API_KEY and COMPUTER_E2B_DOMAIN as the provider's fromEnv does: the key passed to every SDK
// call explicitly, an ambient E2B_SANDBOX_URL refused. It needs no AGENTRUN_COMPUTER_LIVE_E2B: it makes nothing.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { COMPUTER_LABEL } from "../drift.js";
import { type E2BProvider, type E2BSandboxClass, ENV, fromEnv } from "../e2b.js";
import { waitUntil } from "../wait.js";

/** A stream as main writes to it: done is called once the text is handed on. */
export interface Writer {
	write(text: string, done?: (error?: Error | null) => void): unknown;
}

export interface SweepIo {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** The SDK's Sandbox class; imported from the host's e2b package by default. */
	Sandbox?: E2BSandboxClass;
	stdout?: Writer;
	stderr?: Writer;
	/** How long --after reads one killed sandbox back before it counts as still there; default 60 s. */
	waitMs?: number;
	/** The pause between two reads of one sandbox; default 2 s. */
	pollMs?: number;
}

const USAGE = `usage: node packages/computer/dist/conformance/e2b-sweep.js --before <file> | --after <file>
  --before <file>  record the id of every sandbox E2B lists with ${COMPUTER_LABEL}=1 into <file>
  --after <file>   kill every sandbox listed with ${COMPUTER_LABEL}=1 whose id is not in <file>, read each back until
                   E2B no longer has it (up to 60 s each), and print {"swept":n,"gone":m,"stillThere":[ids]}
  settings: ${ENV.key} (required) and ${ENV.domain}, as the provider reads them; never E2B_API_KEY
exit: 0 every swept sandbox is gone, 1 one is still there, 2 usage error, unreadable before file, no key, or a refused listing`;

class Usage extends Error {}

const write = (stream: Writer, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()));

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
	let provider: E2BProvider;
	try {
		args = parse(argv);
		if (args.mode === "after") before = beforeIds(args.file);
		provider = await fromEnv(env, { ...(io.Sandbox ? { Sandbox: io.Sandbox } : {}), timeouts: { goneMs: waitMs, pollMs } });
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${error instanceof Usage ? `${USAGE}\n` : ""}`);
		return 2;
	}
	const listed = await provider.listLabelled();
	if (!listed.ok) {
		await write(stderr, `listing the sandboxes carrying ${COMPUTER_LABEL}=1 failed, so nothing was ${args.mode === "after" ? "killed" : "recorded"}: ${listed.error.message}\n`);
		return 2;
	}
	if (before === undefined) {
		const ids = listed.value.map((sb) => sb.id).sort();
		writeFileSync(args.file, `${JSON.stringify({ label: `${COMPUTER_LABEL}=1`, at: new Date().toISOString(), ids }, null, 2)}\n`);
		await write(stdout, `${JSON.stringify({ recorded: ids.length, file: args.file })}\n`);
		return 0;
	}
	const known = before;
	const fresh = listed.value.filter((sb) => !known.has(sb.id)).map((sb) => sb.id);
	for (const id of fresh) {
		const killed = await provider.killById(id);
		if (!killed.ok) await write(stderr, `${id} was not killed: ${killed.error.message}\n`);
	}
	// Each read back on its own, at once: gone once getInfo no longer finds it and the label listing no longer shows it.
	const gone = await Promise.all(
		fresh.map(async (id) => {
			const waited = await waitUntil(
				async () => {
					const read = await provider.probeGone(id);
					if (!read.ok || !read.value.gone) return read.ok ? `E2B reads it ${read.value.state}` : read.error.message;
					const again = await provider.listLabelled();
					if (!again.ok) return again.error.message;
					return again.value.some((sb) => sb.id === id) ? "still listed" : "gone";
				},
				(state) => state === "gone",
				{ boundMs: waitMs, minMs: pollMs, maxMs: pollMs, what: `${id} to be gone after its kill`, describe: (state) => state },
			);
			if (!waited.ok) await write(stderr, `${id} is still there after ${waitMs / 1000} s: ${waited.error.message}\n`);
			return waited.ok;
		}),
	);
	const stillThere = fresh.filter((_, i) => !gone[i]);
	await write(stdout, `${JSON.stringify({ swept: fresh.length, gone: fresh.length - stillThere.length, stillThere })}\n`);
	return stillThere.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
