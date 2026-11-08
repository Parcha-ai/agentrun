// The E2B network diagnostic, run once by hand with a key the lead has OKed:
//
//   AGENTRUN_COMPUTER_LIVE_E2B=1 COMPUTER_E2B_API_KEY=... node packages/computer/dist/conformance/e2b-diagnose.js
//
// E2B documents that its firewall accepts an outbound TCP connection before it decides whether the destination is
// allowed, so from inside a sandbox with no internet access a connection can succeed while nothing reaches the
// destination (docs.e2b.dev network/internet-access, "Behavior of blocked TCP connections"). The provider's network-none
// probe refuses only on an answer and records an accept with nothing back in its notes. This makes ONE sandbox exactly as the provider makes one for network
// none (diagnoseNetworkNone in ../e2b.ts: the same create options, read-back, upload and sha256 check), runs
// `computerd probe --diagnose` in it (per well-known public address and port: refused, accepted with no answer, or
// answered), prints one JSON line, then kills the sandbox and reads it back gone, on an error and on an abort (SIGINT,
// SIGTERM, or the run's own 8-minute bound) too. Its E2B timeout is 10 minutes. It changes nothing in the provider.
//
// Settings are the provider's (COMPUTER_E2B_API_KEY, COMPUTER_E2B_DOMAIN, COMPUTER_E2B_KIND, COMPUTER_E2B_DAEMON; never
// E2B_API_KEY), and the template is COMPUTER_E2B_TEMPLATE as for conformance (default "desktop"). The live switch is
// checked before any of them is read. Exit 0 when a diagnosis came back and the sandbox reads gone, 1 otherwise, 2 on a
// usage error, no live switch, or a setting the provider refuses (nothing is made then).
import { diagnoseNetworkNone, type E2BFromEnvOptions, ENV, fromEnv } from "../e2b.js";
import { isCommand } from "../entry.js";
import { conformanceImage, E2B_ENV } from "./e2b.js";

/** A stream as main writes to it: done is called once the text is handed on. */
export interface Writer {
	write(text: string, done?: (error?: Error | null) => void): unknown;
}

export interface DiagnoseIo extends Pick<E2BFromEnvOptions, "Sandbox" | "daemonPath" | "timeouts"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	stdout?: Writer;
	stderr?: Writer;
	/** Aborts the diagnostic: the sandbox is still killed and read back gone. */
	signal?: AbortSignal;
	/** The longest the diagnostic runs before it aborts itself; default 8 minutes, inside the sandbox's 10. */
	boundMs?: number;
}

const USAGE = `usage: ${E2B_ENV.live}=1 ${ENV.key}=<key> node packages/computer/dist/conformance/e2b-diagnose.js
  makes one E2B sandbox as the provider makes one for network none, runs computerd probe --diagnose in it, prints one
  JSON line, and kills the sandbox and reads it back gone. It takes no argument; the template is ${E2B_ENV.template}.
exit: 0 diagnosed and gone, 1 otherwise, 2 usage error, no live switch, or a refused setting`;

const BOUND_MS = 8 * 60_000;

const write = (stream: Writer, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()));

export async function main(argv: string[], io: DiagnoseIo = {}): Promise<number> {
	const { env = process.env, stdout = process.stdout, stderr = process.stderr, boundMs = BOUND_MS } = io;
	if (env[E2B_ENV.live] !== "1") {
		await write(stderr, `the E2B network diagnostic makes a real sandbox: set ${E2B_ENV.live}=1, with a key the lead has OKed, to run it\n`);
		return 2;
	}
	if (argv.length > 0) {
		await write(stderr, `it takes no argument, not ${argv.join(" ")}\n${USAGE}\n`);
		return 2;
	}
	const key = env[ENV.key] ?? "";
	// Nothing the SDK or E2B says reaches an output with the key in it.
	const clean = (text: string) => (key === "" ? text : text.split(key).join("[key]"));
	let provider: Awaited<ReturnType<typeof fromEnv>>;
	try {
		provider = await fromEnv(env, { ...(io.Sandbox ? { Sandbox: io.Sandbox } : {}), ...(io.daemonPath === undefined ? {} : { daemonPath: io.daemonPath }), ...(io.timeouts ? { timeouts: io.timeouts } : {}) });
	} catch (error) {
		await write(stderr, `${clean((error as Error).message)}\n`);
		return 2;
	}
	const signal = AbortSignal.any([AbortSignal.timeout(boundMs), ...(io.signal ? [io.signal] : [])]);
	const report = await diagnoseNetworkNone(provider, { image: conformanceImage({ env }), signal });
	await write(stdout, `${clean(JSON.stringify(report))}\n`);
	if (!report.released.gone) await write(stderr, `the sandbox was not read back gone: ${clean(report.released.words)}\n`);
	return report.diagnosis !== undefined && report.released.gone ? 0 : 1;
}

if (isCommand(import.meta)) {
	const controller = new AbortController();
	for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => controller.abort());
	process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
}
