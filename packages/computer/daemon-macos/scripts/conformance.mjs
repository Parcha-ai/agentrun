// A conformance module for this Mac's Computerd: each computer the suite makes is the Mac itself, connected through
// Computerd.app's computerd command (the stdio binding over the app's socket). CI runs the ui cases with it, against
// the ui fixture app (UIFixture.app, installed in /Applications):
//
//   npm run conformance -w @parcha/agentrun-computer -- --provider "$PWD/packages/computer/daemon-macos/scripts/conformance.mjs" --only ui
//
// COMPUTERD is the computerd command (default /Applications/Computerd.app/Contents/Helpers/computerd), and
// COMPUTERD_HOME the app's folder, as the app was started with. It needs packages/computer built (npm run build).
import { spawn } from "node:child_process";
import { DaemonClient, fail, ok } from "../../dist/index.js";

export const ENV = { command: "COMPUTERD", home: "COMPUTERD_HOME" };
export const conformanceNotes = ["each computer is this Mac, through Computerd's computerd command: it is never made or deleted"];
export const conformanceImage = () => "this-mac";

export function createProvider(options = {}) {
	const env = options.env ?? process.env;
	const command = env.COMPUTERD ?? "/Applications/Computerd.app/Contents/Helpers/computerd";
	const made = new Map();
	let next = 1;
	const capabilities = {
		kind: "desktop",
		lifetime: "vendor",
		network: ["open"],
		isolation: "machine",
		os: "macos",
		daemon: "none",
		groups: ["apps", "ui"],
		maxLifetimeMs: 60 * 60_000,
		release: ["delete"],
	};
	const missing = (id) => fail("not_found", `no computer ${id}: this module made none by that id`);
	// As the attached provider (src/attach.ts): a person's Mac keeps its own network, so only "open" is taken.
	const networkRefusal = (asked) => `this Mac is on its own network, which a run cannot block or limit: network ${JSON.stringify(asked)} is refused; ask for network "open"`;
	return {
		id: "computerd-macos",
		version: "local",
		capabilities: () => capabilities,
		check: (spec) => (spec.network === "open" ? [] : [{ field: "network", message: networkRefusal(spec.network) }]),
		async create(spec) {
			const refusals = this.check(spec);
			if (refusals.length > 0) return fail("refused", refusals.map((refusal) => refusal.message).join("; "));
			const id = `mac-${next++}`;
			made.set(id, { labels: { ...spec.labels }, deadline: new Date(Date.now() + (spec.lifetimeMs ?? capabilities.maxLifetimeMs)), image: spec.image, connections: new Set() });
			return ok({ id, name: id });
		},
		async attach(ref) {
			const id = "id" in ref ? ref.id : [...made].find(([, m]) => Object.entries(ref.labels).every(([key, value]) => m.labels[key] === value))?.[0];
			const m = id === undefined ? undefined : made.get(id);
			if (m === undefined) return missing("id" in ref ? ref.id : JSON.stringify(ref.labels));
			return ok({ id, name: id, spec: { image: m.image, network: "open", kind: capabilities.kind, deadline: m.deadline } });
		},
		async list(labels) {
			const matching = [...made].filter(([, m]) => Object.entries(labels).every(([key, value]) => m.labels[key] === value));
			return ok(matching.map(([id, m]) => ({ ref: { id, name: id }, labels: m.labels, deadline: m.deadline, state: "running", network: "open" })));
		},
		async network(ref, policy) {
			if (!made.has(ref.id)) return missing(ref.id);
			if (policy !== undefined && policy !== "open") return fail("refused", networkRefusal(policy));
			return ok("open");
		},
		async connect(ref) {
			const m = made.get(ref.id);
			if (m === undefined) return missing(ref.id);
			const child = spawn(command, ["stdio"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
			const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
			const close = async () => {
				m.connections.delete(close);
				client.close();
				child.stdin.end();
				if (child.exitCode === null) child.kill();
			};
			m.connections.add(close);
			const hello = await client.call("hello", { client: "conformance" });
			if (!hello.ok) {
				await close();
				return hello;
			}
			return ok({ client, hello: hello.value, close });
		},
		// Release ends the run's hold, and closes every connection it was given: calls in flight come back aborted or
		// gone, as the attached provider's do. The Mac itself is never stopped or deleted.
		async release(ref, how) {
			const m = made.get(ref.id);
			if (m === undefined) return missing(ref.id);
			if (how === "stop") return fail("unsupported", "this Mac is never stopped by the suite");
			await Promise.all([...m.connections].map((close) => close()));
			made.delete(ref.id);
			return ok(undefined);
		},
	};
}
