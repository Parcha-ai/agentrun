// The phone harness for the conformance CLI and the live harness (`--provider phone-harness`): the provider as create()
// builds it from the settings this module reads (COMPUTER_PHONE_HARNESS_*), with its ledger in a JSON file so a sweep in
// another process sees the run's phones, and its drifted twin, whose phone's hello reports another version. A phone is
// rented by the minute, so nothing is built without AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS=1, and a run's phones live at
// most 10 min.
// The provider reads no environment: this module reads these names and passes them in as options.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AdbTransport, create, type PhoneHarnessProvider, type PhoneLedger, type PhoneLedgerEntry, type PhoneProviderOptions } from "../phone-harness.js";

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

/** A ledger in a JSON file (mode 0600), read and written whole on each call, the write by rename. */
export function fileLedger(path: string): PhoneLedger {
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
		put: (entry) => write({ ...read(), [entry.id]: entry }),
		get: (id) => read()[id],
		list: () => Object.values(read()),
		remove: (id) => {
			const entries = read();
			if (!(id in entries)) return;
			delete entries[id];
			write(entries);
		},
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
		adb: adb ?? settings.adb ?? "adb",
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
	return "android";
}

export const conformanceNotes = [
	"phone-harness: a temporary cloud Android emulator, driven over adb; a phone is billed by the minute, and lives at most 10 min in a run",
];
