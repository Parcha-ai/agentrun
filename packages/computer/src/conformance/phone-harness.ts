// The phone harness for the conformance CLI and the live harness (`--provider phone-harness`): the provider as create()
// builds it from the settings this module reads (COMPUTER_PHONE_HARNESS_*), with its ledger in a JSON file so a sweep in
// another process sees the run's phones, and its drifted twin, whose phone's hello reports another version. A phone is
// rented by the minute, so nothing is built without AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS=1, and a run's phones live at
// most 10 min.
// The provider reads no environment: this module reads these names and passes them in as options.
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PHONE_IMAGE } from "../descriptors/phone-harness.js";
import { type AdbTransport, adbCli, create, type PhoneHarnessProvider, type PhoneLedger, type PhoneLedgerEntry, type PhoneProviderOptions } from "../phone-harness.js";

/** The environment this module reads, by name. */
export const PHONE_ENV = {
	/** The phone harness API key: this module's own name, never the bare PHONE_HARNESS_API_KEY. */
	key: "COMPUTER_PHONE_HARNESS_API_KEY",
	/** android (the default); ios is refused until it is built. */
	platform: "COMPUTER_PHONE_HARNESS_PLATFORM",
	/** The adb CLI's path; default adb on PATH. */
	adb: "COMPUTER_PHONE_HARNESS_ADB",
	/** The ledger's JSON file; default agentrun-phone-ledger.json in the temp dir. */
	ledger: "COMPUTER_PHONE_HARNESS_LEDGER",
	/** 1 to rent phones at all: each one is billed by the minute. */
	live: "AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS",
} as const;

/** The names this module reads, under the conformance modules' common name. */
export const ENV = PHONE_ENV;

/** A conformance run's phones live at most this long. */
const RUN_MAX_LIFETIME_MS = 10 * 60_000;

export interface PhoneSettings {
	apiKey?: string;
	platform?: "android" | "ios";
	adb?: string;
	ledgerPath?: string;
}

/** The provider's settings this module reads from env, each only when its name is set. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): PhoneSettings {
	return {
		...(env[PHONE_ENV.key] ? { apiKey: env[PHONE_ENV.key] } : {}),
		...(env[PHONE_ENV.platform] ? { platform: env[PHONE_ENV.platform] as PhoneSettings["platform"] } : {}),
		...(env[PHONE_ENV.adb] ? { adb: env[PHONE_ENV.adb] } : {}),
		...(env[PHONE_ENV.ledger] ? { ledgerPath: env[PHONE_ENV.ledger] } : {}),
	};
}

/** How long a writer waits for a live writer's lock on the ledger. A write holds it for well under a millisecond. */
const LOCK_WAIT_MS = 10_000;

/** Whether the process pid is alive on this host: signal 0 tests it and sends nothing. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it lives, under another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A lock file's words, `<pid> <token>`, or undefined when it is gone. */
function lockWords(lockPath: string): string | undefined {
	try {
		return readFileSync(lockPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Whether a lock's words name a holder that is gone: a pid no process holds, or no pid at all (a file left torn). */
const leftByTheDead = (words: string) => {
	const pid = Number(words.split(" ")[0]);
	return !(Number.isSafeInteger(pid) && pid > 0) || !alive(pid);
};

/**
 * Takes a file lock at lockPath, made whole with its holder's words (`<pid> <token>`): it is written to a file of its
 * own, then hard-linked into place, which fails when the lock exists, so no reader ever sees it empty. Answers whether
 * it was taken.
 */
function take(lockPath: string, words: string): boolean {
	const temp = `${lockPath}.${randomBytes(6).toString("hex")}`;
	writeFileSync(temp, words, { mode: 0o600 });
	try {
		linkSync(temp, lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return false;
	} finally {
		unlinkSync(temp);
	}
}

/**
 * Removes the lock at lockPath if it still holds `dead`, the words of a holder found gone. Breakers take turns by a
 * second lock (<lock>.break, also naming its holder), and the lock is read again under it. So a lock is broken once:
 * a waiter that judged the same dead lock never removes the lock another has taken since.
 *
 * Answers whether it moved things on: it broke the lock (or found it gone), or removed a breaker that had died. False
 * when another breaker, alive, holds <lock>.break: the caller waits for it, under its deadline, as for any live holder.
 */
function breakDead(lockPath: string, dead: string, words: string): boolean {
	const breaker = `${lockPath}.break`;
	if (!take(breaker, words)) {
		// Another waiter is breaking it. A breaker that died midway leaves its own lock, named by it: that one goes too.
		// Two waiters may both find it dead and both remove it: the second finds it gone, and goes on.
		const other = lockWords(breaker);
		if (other === undefined) return true;
		if (leftByTheDead(other) && lockWords(breaker) === other) {
			removeIfThere(breaker);
			return true;
		}
		return false;
	}
	try {
		if (lockWords(lockPath) === dead) removeIfThere(lockPath);
	} finally {
		removeIfThere(breaker);
	}
	return true;
}

/** Removes the file at path. One another waiter removed first is gone already, as asked: that is no failure. */
function removeIfThere(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * A ledger in a JSON file (mode 0600), read whole on each call and written whole by rename, so a reader never sees half
 * a file. Writes (put, remove) are one at a time across processes: in this process through one queue, and between
 * processes by a lock file beside the ledger (<path>.lock), so a write never drops another's entry.
 *
 * The lock names its holder (`<pid> <token>`), and is judged by that holder, not by its age. A live writer's lock is
 * never taken, however old: a write waits for it, up to waitMs (10 s by default) for one holder that never lets go,
 * then fails in words. A lock that keeps passing between live writers is progress, and is waited for. A lock whose
 * holder is gone (it crashed mid-write) is broken at once, by one waiter.
 */
export function fileLedger(path: string, { waitMs = LOCK_WAIT_MS }: { waitMs?: number } = {}): PhoneLedger {
	const lockPath = `${path}.lock`;
	let queue: Promise<unknown> = Promise.resolve();
	/** fn under the lock, after every earlier write of this process. */
	const locked = <T>(fn: () => T): Promise<T> => {
		const turn = queue.then(async () => {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const words = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
			// waitMs bounds one holder that never lets go, not other writers' progress. A lock that passes from writer to
			// writer (its words change) is progress: the wait starts again. Under load, writers that each hold it briefly can
			// together keep it longer than waitMs, and that is no stuck writer (CI, run 42672928685).
			let seen: string | undefined;
			let until = Date.now() + waitMs;
			for (let wait = 2; !take(lockPath, words); wait = Math.min(wait * 2, 50)) {
				const held = lockWords(lockPath);
				if (held === undefined) continue;
				if (held !== seen) {
					seen = held;
					until = Date.now() + waitMs;
				}
				// A dead holder's lock is broken at once; a live breaker at work on it is waited for, like a live holder.
				if (leftByTheDead(held) && breakDead(lockPath, held, words)) continue;
				if (Date.now() >= until) throw new Error(`the phone ledger ${path} stayed locked by another writer for ${waitMs / 1000} s, which held it all that time (${lockPath})`);
				await new Promise((resolve) => setTimeout(resolve, wait));
			}
			try {
				return fn();
			} finally {
				// Only its own lock: never one a breaker let another take.
				if (lockWords(lockPath) === words) removeIfThere(lockPath);
			}
		});
		queue = turn.catch(() => undefined);
		return turn;
	};
	const read = (): Record<string, PhoneLedgerEntry> => {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`the phone ledger ${path} is unreadable: ${(error as Error).message}`);
		}
	};
	const write = (entries: Record<string, PhoneLedgerEntry>) => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, path);
	};
	return {
		put: (entry) => locked(() => write({ ...read(), [entry.id]: entry })),
		get: (id) => read()[id],
		list: () => Object.values(read()),
		remove: (id) =>
			locked(() => {
				const entries = read();
				if (!(id in entries)) return;
				delete entries[id];
				write(entries);
			}),
	};
}

export interface PhoneModuleOptions extends Pick<PhoneProviderOptions, "fetch" | "now" | "sleep" | "baseUrl"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** The adb runner; default the CLI the settings name. */
	adb?: AdbTransport | string;
}

function optionsOf({ env = process.env, adb, ...rest }: PhoneModuleOptions): PhoneProviderOptions {
	if (env[PHONE_ENV.live] !== "1") throw new Error(`a conformance run rents a cloud phone, billed by the minute: set ${PHONE_ENV.live}=1 to run it`);
	const settings = settingsFromEnv(env);
	if (!settings.apiKey) throw new Error(`set ${PHONE_ENV.key} to the phone harness API key`);
	return {
		apiKey: settings.apiKey,
		...(settings.platform ? { platform: settings.platform } : {}),
		// Every adb the run spawns, from a path given as the adb option or by its setting, starts from this environment
		// with every adb variable dropped (adbCli's env), and this module's own names too: the API key has no business in
		// adb's environment. A transport given as the option is used as it is: it spawns nothing of this module's.
		adb: adb !== undefined && typeof adb !== "string" ? adb : adbCli(adb ?? settings.adb ?? "adb", { env: Object.fromEntries(Object.entries(env).filter(([name]) => !(Object.values(PHONE_ENV) as string[]).includes(name))) }),
		ledger: fileLedger(settings.ledgerPath ?? join(tmpdir(), "agentrun-phone-ledger.json")),
		maxLifetimeMs: RUN_MAX_LIFETIME_MS,
		...rest,
	};
}

/** The provider the CLI runs. */
export async function createProvider(options: PhoneModuleOptions = {}): Promise<PhoneHarnessProvider> {
	return create(optionsOf(options));
}

/** The same provider, whose phone's hello reports another version: connect refuses it, for the drift.version case. */
export async function createDriftedProvider(options: PhoneModuleOptions = {}): Promise<PhoneHarnessProvider> {
	return create({ ...optionsOf(options), daemonVersion: "0.0.0-drift" });
}

/** The image a run names: a cloud Android has none to choose, so it is read back as this name. */
export function conformanceImage(): string {
	return PHONE_IMAGE;
}

export const conformanceNotes = [
	"phone-harness: a temporary cloud Android emulator, driven over adb; a phone is billed by the minute, and lives at most 10 min in a run",
];
