import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
	createExpectAssertions,
	type EnvConformanceAssertions,
	type StorageConformanceRunner,
} from "@earendil-works/pi-durable/testing";
import type { Box, BoxProcess, BoxProvider, BoxSpec } from "../box/box.ts";
import { finish, readStream } from "../box/files.ts";

const DEFAULT_LARGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LIFETIME_MS = 10 * 60_000;
const CONFORMANCE_LABEL = "conformance-run";
const SPEC_ENV_NAME = "PI_TRANSPORT_CONFORMANCE";

/** Calls `use` once with the provider under test, then cleans up whatever the provider itself needs. */
export type BoxConformanceProvider = (use: (provider: BoxProvider) => Promise<void>) => Promise<void>;

export interface BoxConformanceOptions {
	readonly assertions: EnvConformanceAssertions;
	readonly withProvider: BoxConformanceProvider;
	/** Merged into the spec of every box the suite creates, for example an image. */
	readonly spec?: Partial<BoxSpec>;
	/** Size of the large file round trip. Default 8 MiB. */
	readonly largeBytes?: number;
	/** Names set in the host process's environment that no program in a box may see. */
	readonly absentEnv?: readonly string[];
	/**
	 * For a provider whose programs' output reaches the host as text, not bytes (a vendor SDK whose output callbacks give
	 * strings): the byte-value case carries the values 0 to 127, which text keeps, and not 128 to 255. Input is bytes
	 * either way; the file round trips (`upload`, `download`) always carry every value.
	 */
	readonly textOutput?: boolean;
	/**
	 * When set, the suite creates one box with this lifetime, starts a long program in it, makes no further call to
	 * the provider, and requires `ended` to say the box is gone within `graceMs` after the lifetime. This is the bound
	 * on leaked boxes, so `ended` must look at the machine itself (a process table, a container list, the vendor's
	 * own API) and never at the provider under test, whose answers could end the box or only claim it ended.
	 */
	readonly lifetime?: {
		readonly maxLifetimeMs: number;
		readonly graceMs: number;
		ended(box: Box): Promise<boolean>;
	};
}

export interface BoxConformanceCase {
	readonly name: string;
	/** Cases that create a box need longer than a test runner's default timeout on a remote provider. */
	readonly timeoutMs?: number;
	run(): Promise<void>;
}

const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Runner-independent cases every `BoxProvider` must pass before the rest of this package is trusted on it. */
export function createBoxConformance(options: BoxConformanceOptions): BoxConformanceCase[] {
	const { assertions, withProvider } = options;
	const label = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const spec: BoxSpec = {
		maxLifetimeMs: DEFAULT_MAX_LIFETIME_MS,
		...options.spec,
		env: { ...options.spec?.env, [SPEC_ENV_NAME]: "yes" },
		labels: { ...options.spec?.labels, [CONFORMANCE_LABEL]: label },
	};

	const withBox = (use: (box: Box, provider: BoxProvider) => Promise<void>) =>
		withProvider(async (provider) => {
			const box = unwrap(await provider.create(spec, context));
			try {
				await use(box, provider);
			} finally {
				await box.destroy(context);
			}
		});

	const start = async (box: Box, command: readonly string[], timeoutMs?: number): Promise<BoxProcess> =>
		unwrap(await box.exec(command, timeoutMs === undefined ? undefined : { timeoutMs }, context));

	const run = async (box: Box, command: readonly string[], input?: Uint8Array) => {
		const finished = unwrap(await finish(await start(box, command), input));
		return { exitCode: finished.exitCode, stdout: decoder.decode(finished.stdout), stderr: finished.stderr };
	};

	const cases: BoxConformanceCase[] = [
		{
			name: "create returns a running box that attach finds by its id",
			run: () =>
				withBox(async (box, provider) => {
					assertions.ok(box.id.length > 0, "the box has an id");
					assertions.deepEqual(unwrap(await box.status(context)), { state: "running" });
					const attached = unwrap(await provider.attach(box.id, context));
					assertions.strictEqual(attached?.id, box.id);
					assertions.deepEqual(attached?.facts(), box.facts());
					assertions.strictEqual((await run(attached as Box, ["printf", "%s", "attached"])).stdout, "attached");
				}),
		},
		{
			name: "attach returns undefined for an id that does not exist",
			run: () =>
				withProvider(async (provider) => {
					assertions.strictEqual(unwrap(await provider.attach("no-such-box-0000", context)), undefined);
				}),
		},
		{
			name: "facts name the provider, an absolute workspace and the lifetime",
			run: () =>
				withBox(async (box, provider) => {
					const facts = box.facts();
					assertions.strictEqual(facts.provider, provider.name);
					assertions.ok(facts.workspace.startsWith("/"), "the workspace is an absolute path");
					assertions.ok(
						facts.maxLifetimeMs === null || facts.maxLifetimeMs >= spec.maxLifetimeMs,
						"the lifetime is at least what the spec asked for",
					);
				}),
		},
		{
			name: "exec passes arguments to the program unparsed",
			run: () =>
				withBox(async (box) => {
					const result = await run(box, ["printf", "%s|%s", "a b", "$HOME;`id` *"]);
					assertions.strictEqual(result.exitCode, 0);
					assertions.strictEqual(result.stdout, "a b|$HOME;`id` *");
				}),
		},
		{
			name: "exec reports a non-zero exit code as a value",
			run: () =>
				withBox(async (box) => {
					assertions.strictEqual((await run(box, ["sh", "-c", "exit 7"])).exitCode, 7);
				}),
		},
		{
			name: "exec keeps stdout and stderr apart",
			run: () =>
				withBox(async (box) => {
					const result = await run(box, ["sh", "-c", "printf out; printf err >&2"]);
					assertions.strictEqual(result.stdout, "out");
					assertions.strictEqual(result.stderr, "err");
				}),
		},
		{
			name: "exec streams output before the program exits and carries input to it",
			run: () =>
				withBox(async (box) => {
					const process = await start(box, ["sh", "-c", 'echo ready; read line; echo "got $line"']);
					const errors = readStream(process.stderr);
					const output = process.stdout[Symbol.asyncIterator]();
					const first = await output.next();
					assertions.ok(!first.done && decoder.decode(first.value).includes("ready"), "output arrives early");
					await process.stdin.write(encoder.encode("ping\n"));
					await process.stdin.close();
					let rest = "";
					for (let next = await output.next(); !next.done; next = await output.next()) {
						rest += decoder.decode(next.value);
					}
					assertions.ok(rest.includes("got ping"), "the program read its input");
					await errors;
					assertions.strictEqual(unwrap(await process.wait()), 0);
				}),
		},
		{
			name: "input and output carry every byte value",
			run: () =>
				withBox(async (box) => {
					const bytes = Uint8Array.from(
						{ length: 1024 },
						(_, index) => index % (options.textOutput === true ? 128 : 256),
					);
					const finished = unwrap(await finish(await start(box, ["cat"]), bytes));
					assertions.strictEqual(finished.exitCode, 0);
					assertions.deepEqual(Array.from(finished.stdout), Array.from(bytes));
				}),
		},
		{
			name: "programs start in the workspace and its files persist between calls",
			run: () =>
				withBox(async (box) => {
					assertions.strictEqual((await run(box, ["sh", "-c", "printf hi > note.txt"])).exitCode, 0);
					const [relative] = unwrap(await box.download(["note.txt"], context));
					assertions.strictEqual(decoder.decode(relative?.bytes), "hi");
					const [absolute] = unwrap(await box.download([`${box.facts().workspace}/note.txt`], context));
					assertions.strictEqual(decoder.decode(absolute?.bytes), "hi");
				}),
		},
		{
			name: "upload creates parent directories and keeps the mode",
			run: () =>
				withBox(async (box) => {
					const script = encoder.encode("#!/bin/sh\nprintf ran\n");
					unwrap(await box.upload([{ path: "deep/er/run.sh", bytes: script, mode: 0o755 }], context));
					const result = await run(box, ["./deep/er/run.sh"]);
					assertions.strictEqual(result.exitCode, 0);
					assertions.strictEqual(result.stdout, "ran");
				}),
		},
		{
			name: "a large file survives the round trip",
			timeoutMs: 120_000,
			run: () =>
				withBox(async (box) => {
					const bytes = new Uint8Array(options.largeBytes ?? DEFAULT_LARGE_BYTES);
					for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + (index >> 8)) % 256;
					unwrap(await box.upload([{ path: "large.bin", bytes }], context));
					const [file] = unwrap(await box.download(["large.bin"], context));
					assertions.strictEqual(file?.bytes.length, bytes.length);
					assertions.strictEqual(await sha256(file?.bytes ?? new Uint8Array()), await sha256(bytes));
				}),
		},
		{
			name: "download fails with not_found for a file that does not exist",
			run: () =>
				withBox(async (box) => {
					const result = await box.download(["missing.txt"], context);
					assertions.strictEqual(result.ok, false);
					if (!result.ok) assertions.strictEqual(result.error.code, "not_found");
				}),
		},
		{
			name: "a timeout ends the wait with a timeout error",
			run: () =>
				withBox(async (box) => {
					const process = await start(box, ["sleep", "30"], 500);
					void readStream(process.stdout).catch(() => {});
					void readStream(process.stderr).catch(() => {});
					const exit = await process.wait();
					assertions.strictEqual(exit.ok, false);
					if (!exit.ok) assertions.strictEqual(exit.error.code, "timeout");
				}),
		},
		{
			name: "an aborted context ends the wait with an aborted error",
			run: () =>
				withBox(async (box) => {
					const cancellable = withCancel(context);
					const started = unwrap(await box.exec(["sleep", "30"], undefined, cancellable.context));
					void readStream(started.stdout).catch(() => {});
					void readStream(started.stderr).catch(() => {});
					setTimeout(() => cancellable.cancel(), 200);
					const exit = await started.wait();
					assertions.strictEqual(exit.ok, false);
					if (!exit.ok) assertions.strictEqual(exit.error.code, "aborted");
				}),
		},
		{
			name: "programs see the spec's env and nothing of the host's environment",
			run: () =>
				withBox(async (box) => {
					const read = (name: string) => run(box, ["sh", "-c", `printf %s "\${${name}-unset}"`]);
					assertions.strictEqual((await read(SPEC_ENV_NAME)).stdout, "yes");
					for (const name of options.absentEnv ?? []) {
						assertions.strictEqual((await read(name)).stdout, "unset");
					}
				}),
		},
		{
			name: "list finds the box by its labels and by no other value",
			run: () =>
				withBox(async (box, provider) => {
					const found = unwrap(await provider.list({ [CONFORMANCE_LABEL]: label }, context));
					assertions.ok(
						found.some((ref) => ref.id === box.id),
						"the box is listed under its label",
					);
					const other = unwrap(await provider.list({ [CONFORMANCE_LABEL]: `${label}-other` }, context));
					assertions.deepEqual(other, []);
				}),
		},
		{
			name: "destroy ends the box for every later call and may be repeated",
			run: () =>
				withBox(async (box, provider) => {
					unwrap(await box.destroy(context));
					assertions.strictEqual(unwrap(await box.status(context)).state, "ended");
					assertions.strictEqual(unwrap(await provider.attach(box.id, context)), undefined);
					const started = await box.exec(["true"], undefined, context);
					const exit = started.ok ? unwrap(await finishExit(started.value)) : started;
					assertions.strictEqual(exit.ok, false);
					if (!exit.ok) assertions.strictEqual(exit.error.code, "gone");
					unwrap(await box.destroy(context));
				}),
		},
	];
	cases.push({
		name: "a label in the providers' own namespace is refused before a box exists",
		run: () =>
			withProvider(async (provider) => {
				for (const key of ["pi-transport", "pi-transport.conformance"]) {
					const refused = await provider.create({ ...spec, labels: { ...spec.labels, [key]: "1" } }, context);
					if (refused.ok) await refused.value.destroy(context);
					assertions.strictEqual(refused.ok, false);
					if (!refused.ok) assertions.strictEqual(refused.error.code, "invalid");
				}
			}),
	});
	const lifetime = options.lifetime;
	if (lifetime !== undefined) {
		cases.push({
			name: "a box and its programs end by themselves once the lifetime has passed",
			timeoutMs: lifetime.maxLifetimeMs + lifetime.graceMs + 60_000,
			run: () =>
				withProvider(async (provider) => {
					const box = unwrap(await provider.create({ ...spec, maxLifetimeMs: lifetime.maxLifetimeMs }, context));
					try {
						const program = await start(box, ["sleep", "86400"]);
						void readStream(program.stdout).catch(() => {});
						void readStream(program.stderr).catch(() => {});
						void program.wait();
						assertions.strictEqual(await lifetime.ended(box), false);
						// No call to the provider from here on: the provider must end the box with no help.
						await new Promise((resolve) => setTimeout(resolve, lifetime.maxLifetimeMs));
						const deadline = Date.now() + lifetime.graceMs;
						const pauseMs = Math.max(250, Math.min(5_000, lifetime.graceMs / 10));
						let ended = await lifetime.ended(box);
						while (!ended && Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, pauseMs));
							ended = await lifetime.ended(box);
						}
						assertions.ok(ended, "the provider ended the box and its program with no call from the host");
					} finally {
						await box.destroy(context);
					}
				}),
		});
	}
	return cases;
}

/** Read both streams of a program to their end and return its exit, error included, as a value. */
async function finishExit(process: BoxProcess) {
	await process.stdin.close().catch(() => {});
	const [exit] = await Promise.all([process.wait(), readStream(process.stdout), readStream(process.stderr)]);
	return { ok: true as const, value: exit };
}

/** Registers the box conformance cases with a Vitest or Jest compatible test runner. */
export function registerBoxConformance(
	runner: StorageConformanceRunner,
	name: string,
	withProvider: BoxConformanceProvider,
	options: Omit<BoxConformanceOptions, "assertions" | "withProvider"> = {},
): void {
	const cases = createBoxConformance({ ...options, assertions: createExpectAssertions(runner.expect), withProvider });
	runner.describe(name, () => {
		for (const testCase of cases) runner.it(testCase.name, testCase.run, testCase.timeoutMs);
	});
}
