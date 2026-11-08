// The sweep around a live Modal run, with the provider's settings and client (COMPUTER_MODAL_*, never MODAL_*):
//
//   node packages/computer/dist/conformance/modal-sweep.js --before <file>
//   node packages/computer/dist/conformance/modal-sweep.js --after <file>
//
// --before records into <file> the app and server it listed, and the id of every sandbox in the app COMPUTER_MODAL_APP
// that carries the provider's tag
// agentrun.computer=1: sandboxes.list({ appId, tags }) returns those with at least those tags, and running ones only
// (modal-client@64880502:js/src/sandbox.ts:1116-1159, includeFinished: false), so a finished sandbox is in neither list
// and needs no sweep. --after refuses a file whose app or server is not the one the environment names now, or that
// names none, before it lists anything: another app's computers would all read as new. Otherwise it lists them again, terminates every one whose id is not in <file>, then reads each of those
// back with sandboxes.fromId and poll (sandbox.ts:960-962, 2766-2772; poll is null while it runs) until it reports an
// exit code, or Modal no longer knows it, up to 60 s each, and prints one JSON line, {"swept":n,"gone":m,"stillThere":
// [ids]}: swept is every tagged sandbox it found that was not there before, and gone + stillThere.length = swept. A
// sandbox in <file> is never touched: no call names it. Exit 0 when every swept sandbox has finished, 1 when one still
// runs, 2 on a usage error, a before file it cannot read or of another app or server, a missing token or app, or a
// listing Modal refused (nothing is terminated then).
//
// It reads COMPUTER_MODAL_TOKEN_ID, COMPUTER_MODAL_TOKEN_SECRET, COMPUTER_MODAL_APP and COMPUTER_MODAL_SERVER_URL as the
// conformance module does (settingsFromEnv in ./modal.ts), and builds its client as the provider does (modalClient): the
// token passed explicitly, the server pinned, an ambient MODAL_SERVER_URL refused. It needs no
// AGENTRUN_COMPUTER_LIVE_MODAL: it makes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { COMPUTER_LABEL } from "../drift.js";
import { isCommand } from "../entry.js";
import { MODAL_DEFAULT_SERVER_URL, type ModalClientConstructor, type ModalSandbox, type ModalSdk, modalClient, untilFinished } from "../modal.js";
import { MODAL_ENV, settingsFromEnv } from "./modal.js";

/** A stream as main writes to it: done is called once the text is handed on. */
export interface Writer {
	write(text: string, done?: (error?: Error | null) => void): unknown;
}

export interface SweepIo {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: ModalClientConstructor;
	stdout?: Writer;
	stderr?: Writer;
	/** How long --after reads one terminated sandbox back before it counts as still there; default 60 s. */
	waitMs?: number;
	/** The pause between two reads of one sandbox; default 2 s. */
	pollMs?: number;
	/** One SDK call (apps.fromName, fromId, terminate, poll); default 60 s. */
	callMs?: number;
	/** The whole listing, every page; default 120 s. */
	listMs?: number;
}

const TAG = { [COMPUTER_LABEL]: "1" };
const USAGE = `usage: node packages/computer/dist/conformance/modal-sweep.js --before <file> | --after <file>
  --before <file>  record the app, the server and the id of every running sandbox carrying ${COMPUTER_LABEL}=1 in the app into <file>
  --after <file>   refuse a <file> of another app or server; else terminate every running sandbox carrying ${COMPUTER_LABEL}=1
                   in the app whose id is not in <file>,
                   read each back until it has finished (up to 60 s each), and print {"swept":n,"gone":m,"stillThere":[ids]}
  settings: ${MODAL_ENV.tokenId} and ${MODAL_ENV.tokenSecret} (required), ${MODAL_ENV.app} (required) and
            ${MODAL_ENV.serverUrl}, as the conformance module reads them; never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET
exit: 0 every swept sandbox has finished, 1 one still runs, 2 usage error, unreadable before file or one of another app
      or server, no token or app, or a refused listing`;

class Usage extends Error {}

const write = (stream: Writer, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()));
const words = (error: unknown) => {
	const name = (error as { name?: unknown } | null)?.name;
	const message = error instanceof Error ? error.message : String(error);
	return `${typeof name === "string" && name !== "Error" ? `${name}: ` : ""}${message}`.replace(/\s+/g, " ").slice(0, 300);
};
const notFound = (error: unknown) => {
	const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
	return name === "NotFoundError" || code === 5;
};

/** The call's value, or the error it threw or rejected with; one that does not answer within ms is an error too. */
async function bounded<T>(what: string, run: () => Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
	});
	try {
		return { ok: true, value: await Promise.race([Promise.resolve().then(run), timeout]) };
	} catch (error) {
		return { ok: false, error };
	} finally {
		clearTimeout(timer);
	}
}

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

/** What a before file holds: the app and server it was listed from, and the ids; or why it is not one. */
interface Before {
	app: unknown;
	serverUrl: unknown;
	ids: Set<string>;
}

function readBefore(file: string): Before {
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
	const { ids, app, serverUrl } = (record ?? {}) as { ids?: unknown; app?: unknown; serverUrl?: unknown };
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id !== "")) throw new Usage(`${file} is not a before file: it holds no "ids" array of sandbox ids`);
	return { app, serverUrl, ids: new Set(ids as string[]) };
}

/**
 * Why the before file is not of the app and server the environment names now, or undefined when it is. --after takes
 * every tagged sandbox not in the file as new, so a file of another app, or of the same app name on another server,
 * would have it terminate every computer there.
 */
function otherPlace(file: string, before: Before, app: string, serverUrl: string): string | undefined {
	const refuse = (why: string) => `${file} ${why}, so nothing was listed or terminated: every computer there would read as new`;
	if (typeof before.app !== "string" || before.app === "") return refuse(`names no app; it is not a before file of this sweep`);
	if (typeof before.serverUrl !== "string" || before.serverUrl === "") return refuse(`names no server; it is not a before file of this sweep`);
	if (before.app !== app) return refuse(`was recorded in the app ${before.app}, and ${MODAL_ENV.app} names ${app} now`);
	if (before.serverUrl !== serverUrl) return refuse(`was recorded from ${before.serverUrl}, and the sweep would list ${serverUrl} now (${MODAL_ENV.serverUrl})`);
	return undefined;
}

/** Every running sandbox in the app carrying the tag, by id, the whole listing within listMs. */
async function listTagged(sdk: ModalSdk, app: string, callMs: number, listMs: number): Promise<{ ok: true; value: ModalSandbox[] } | { ok: false; error: unknown }> {
	const found = await bounded(`apps.fromName ${app}`, () => sdk.apps.fromName(app, { createIfMissing: true }), callMs);
	if (!found.ok) return found;
	const appId = found.value.appId;
	return bounded(
		"sandboxes.list",
		async () => {
			const all = new Map<string, ModalSandbox>();
			for await (const sandbox of sdk.sandboxes.list({ appId, tags: { ...TAG } })) all.set(sandbox.sandboxId, sandbox);
			return [...all.values()];
		},
		listMs,
	);
}

export async function main(argv: string[], io: SweepIo = {}): Promise<number> {
	const { env = process.env, stdout = process.stdout, stderr = process.stderr, waitMs = 60_000, pollMs = 2_000, callMs = 60_000, listMs = 120_000 } = io;
	let args: { mode: "before" | "after"; file: string };
	let before: Set<string> | undefined;
	let app: string;
	let sdk: ModalSdk;
	let serverUrl: string;
	try {
		args = parse(argv);
		const recorded = args.mode === "after" ? readBefore(args.file) : undefined;
		const settings = settingsFromEnv(env);
		app = settings.app;
		serverUrl = settings.serverUrl ?? MODAL_DEFAULT_SERVER_URL;
		sdk = await modalClient({ tokenId: settings.tokenId, tokenSecret: settings.tokenSecret, serverUrl, ...(io.ModalClient ? { ModalClient: io.ModalClient } : {}) });
		if (recorded !== undefined) {
			const other = otherPlace(args.file, recorded, app, serverUrl);
			if (other !== undefined) throw new Error(other);
			before = recorded.ids;
		}
	} catch (error) {
		await write(stderr, `${(error as Error).message}\n${error instanceof Usage ? `${USAGE}\n` : ""}`);
		return 2;
	}
	const listed = await listTagged(sdk, app, callMs, listMs);
	if (!listed.ok) {
		await write(stderr, `listing the sandboxes carrying ${COMPUTER_LABEL}=1 in ${app} failed, so nothing was ${args.mode === "after" ? "terminated" : "recorded"}: ${words(listed.error)}\n`);
		return 2;
	}
	if (before === undefined) {
		const ids = listed.value.map((sandbox) => sandbox.sandboxId).sort();
		writeFileSync(args.file, `${JSON.stringify({ tag: `${COMPUTER_LABEL}=1`, app, serverUrl, at: new Date().toISOString(), ids }, null, 2)}\n`);
		await write(stdout, `${JSON.stringify({ recorded: ids.length, file: args.file })}\n`);
		return 0;
	}
	const known = before;
	const fresh = listed.value.filter((sandbox) => !known.has(sandbox.sandboxId));
	for (const sandbox of fresh) {
		const ended = await bounded(`terminate of ${sandbox.sandboxId}`, () => sandbox.terminate(), callMs);
		if (!ended.ok && !notFound(ended.error)) await write(stderr, `${sandbox.sandboxId} was not terminated: ${words(ended.error)}\n`);
	}
	// Each read back on its own, at once, through a new handle and the provider's own wait after a terminate
	// (untilFinished): an exit code, or a sandbox Modal no longer knows, is gone.
	const gone = await Promise.all(
		fresh.map(async ({ sandboxId: id }) => {
			const waited = await untilFinished(async () => (await sdk.sandboxes.fromId(id)).poll(), { name: id, boundMs: waitMs, callMs, minMs: pollMs, maxMs: pollMs });
			if (!waited.ok) await write(stderr, `${id} is still running after ${waitMs / 1000} s: ${waited.error.message}\n`);
			return waited.ok;
		}),
	);
	const stillThere = fresh.filter((_, i) => !gone[i]).map((sandbox) => sandbox.sandboxId);
	await write(stdout, `${JSON.stringify({ swept: fresh.length, gone: fresh.length - stillThere.length, stillThere })}\n`);
	return stillThere.length === 0 ? 0 : 1;
}

if (isCommand(import.meta)) {
	process.exitCode = await main(process.argv.slice(2));
}
