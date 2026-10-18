import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { BoxProvider } from "../src/box/box.ts";
import { readStream } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { type BoxServer, type ProxyBoxes, proxyBoxes, serveBoxes } from "../src/home/boxes.ts";
import { connectHome } from "../src/home/host.ts";
import { type Frame, type Link, linkPair } from "../src/home/link.ts";
import { registerBoxConformance } from "../src/testing/box-conformance.ts";
import { registerHandsCases } from "./hands-support.ts";

const context = BACKGROUND_CONTEXT;
const CANARY = "PI_TRANSPORT_BOXES_CANARY";
process.env[CANARY] = "the host's own environment";

/** Join a runner's box proxy and the host's box server over a fresh pair of links. Returns the runner's end, to cut. */
function connect(proxy: ProxyBoxes, server: BoxServer): Link {
	const [runner, host] = linkPair();
	const toRunner = (frame: Frame) => host.send(frame);
	runner.onFrame((frame) => proxy.receive(frame));
	host.onFrame((frame) => server.receive(frame, toRunner));
	runner.onClose((reason) => proxy.down(reason));
	host.onClose(() => server.down(toRunner));
	proxy.up((frame) => runner.send(frame));
	return runner;
}

/** A runner's providers over the link: the host's local boxes, made and held by the host. */
function served(root: string) {
	const server = serveBoxes({ providers: { local: localBoxes({ root }) } });
	const proxy = proxyBoxes(server.names);
	const link = connect(proxy, server);
	return { server, proxy, link, provider: proxy.providers.local as BoxProvider };
}

let conformanceRoot = "";
let conformanceServer: BoxServer | undefined;

registerBoxConformance(
	{ describe, expect, it },
	"local boxes through the host's box proxy",
	async (use) => {
		conformanceRoot = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(conformanceRoot);
		conformanceServer = made.server;
		try {
			await use(made.provider);
		} finally {
			made.link.close("the suite is done");
			rmSync(conformanceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	{
		absentEnv: [CANARY],
		lifetime: {
			maxLifetimeMs: 1_500,
			graceMs: 5_000,
			// The box the label names, on the host: its directory is gone once its lifetime ran out.
			ended: async (box) => {
				const real = conformanceServer?.held.get(box.id)?.box.id;
				return real !== undefined && !existsSync(join(conformanceRoot, real));
			},
		},
	},
);

// The router over the proxy: every `provider()` is a new runner's proxy on a new link to the same host, so a runner that
// starts again finds its boxes by the labels it kept.
registerHandsCases(
	"hands on the host's boxes, through the box proxy",
	async (use) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-boxes-hands-"));
		const server = serveBoxes({ providers: { local: localBoxes({ root: join(directory, "boxes") }) } });
		const links: Link[] = [];
		try {
			await use({
				provider: () => {
					const proxy = proxyBoxes(server.names);
					links.push(connect(proxy, server));
					return proxy.providers.local as BoxProvider;
				},
				environment: { provider: "local" },
				directory,
			});
		} finally {
			for (const link of links) link.close("the case is done");
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	60_000,
);

describe("the host's box proxy", () => {
	it("names every box by a label, never by the provider's id, and lists only the boxes it made", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		const raw = localBoxes({ root });
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000, labels: { run: "r-1" } }, context));
			const foreign = getOrThrow(await raw.create({ maxLifetimeMs: 60_000, labels: { run: "r-1" } }, context));
			expect(box.id).toBe("box-1");
			const real = made.server.held.get("box-1")?.box.id as string;
			expect(real).not.toBe("box-1");
			expect(getOrThrow(await made.provider.list({ run: "r-1" }, context))).toEqual([
				{ id: "box-1", labels: expect.objectContaining({ run: "r-1" }) },
			]);
			expect(getOrThrow(await made.provider.attach(real, context))).toBeUndefined();
			expect(getOrThrow(await made.provider.attach("box-1", context))?.id).toBe("box-1");
			getOrThrow(await box.destroy(context));
			expect(getOrThrow(await made.provider.attach("box-1", context))).toBeUndefined();
			getOrThrow(await foreign.destroy(context));
		} finally {
			made.link.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("brings a program's output whole and once, and its stdin in order, across a link that drops and comes back", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			// Counts while the link is down, then echoes what stdin says.
			const program = getOrThrow(
				await box.exec(
					["sh", "-c", "for n in 1 2 3 4 5 6; do echo line-$n; sleep 0.1; done; cat; echo exit-now"],
					undefined,
					context,
				),
			);
			const stdout = readStream(program.stdout);
			const stderr = readStream(program.stderr);
			await new Promise((resolve) => setTimeout(resolve, 150));
			made.link.close("the box's network dropped");
			// A write waits for the host to apply it: this one is sent again once the link is back.
			const first = program.stdin.write(new TextEncoder().encode("first "));
			await new Promise((resolve) => setTimeout(resolve, 400));
			const again = connect(made.proxy, made.server);
			await first;
			await program.stdin.write(new TextEncoder().encode("second\n"));
			await program.stdin.close();
			expect(getOrThrow(await program.wait())).toBe(0);
			const text = new TextDecoder().decode(await stdout);
			expect(text).toBe("line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nfirst second\nexit-now\n");
			expect(new TextDecoder().decode(await stderr)).toBe("");
			getOrThrow(await box.destroy(context));
			again.close("done");
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("stops reading a program's output past its window while the runner's link is down, and brings it whole once it is back", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const done = join(box.facts().workspace, "done");
			// Far more output than the window, then a mark that the program got to its end.
			const program = getOrThrow(
				await box.exec(["sh", "-c", `head -c ${16 * 1024 * 1024} /dev/zero; touch done`], undefined, context),
			);
			made.link.close("the box's network dropped");
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			// The host holds a window of output, not all of it: the program waits on its full pipe.
			expect(existsSync(done)).toBe(false);
			const again = connect(made.proxy, made.server);
			const [stdout, stderr] = await Promise.all([readStream(program.stdout), readStream(program.stderr)]);
			expect(getOrThrow(await program.wait())).toBe(0);
			expect(stdout.byteLength).toBe(16 * 1024 * 1024);
			expect(stderr.byteLength).toBe(0);
			expect(existsSync(done)).toBe(true);
			getOrThrow(await box.destroy(context));
			again.close("done");
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("goes on after a link that dropped while the app read what the host had sent: what it read is acknowledged once the link is back", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const program = getOrThrow(
				await box.exec(["sh", "-c", `head -c ${16 * 1024 * 1024} /dev/zero`], undefined, context),
			);
			// Nothing read: the host sends its window and waits for an acknowledgement.
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			made.link.close("the box's network dropped");
			// The app reads what came while the link is down: its acknowledgement cannot leave.
			const read = Promise.all([readStream(program.stdout), readStream(program.stderr)]);
			await new Promise((resolve) => setTimeout(resolve, 500));
			const again = connect(made.proxy, made.server);
			const outcome = await Promise.race([
				read.then(async ([stdout]) => ({ bytes: stdout.byteLength, exit: getOrThrow(await program.wait()) })),
				new Promise((resolve) => setTimeout(() => resolve("stuck at the window"), 20_000)),
			]);
			expect(outcome).toEqual({ bytes: 16 * 1024 * 1024, exit: 0 });
			getOrThrow(await box.destroy(context));
			again.close("done");
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("paces a program by what the app reads: unread output blocks it as a full pipe would", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const done = join(box.facts().workspace, "done");
			const program = getOrThrow(
				await box.exec(["sh", "-c", `head -c ${16 * 1024 * 1024} /dev/zero; touch done`], undefined, context),
			);
			// The link is up and nothing is read: neither the host nor the runner keeps it all.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(existsSync(done)).toBe(false);
			const [stdout] = await Promise.all([readStream(program.stdout), readStream(program.stderr)]);
			expect(getOrThrow(await program.wait())).toBe(0);
			expect(stdout.byteLength).toBe(16 * 1024 * 1024);
			expect(existsSync(done)).toBe(true);
			getOrThrow(await box.destroy(context));
		} finally {
			made.link.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("sends no exec whose context is already aborted: the program never starts, and the call says aborted", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const controller = new AbortController();
			controller.abort();
			const started = await box.exec(
				["sh", "-c", "touch started"],
				undefined,
				withAbortSignal(controller.signal, context),
			);
			expect(started.ok ? "started" : started.error.code).toBe("aborted");
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(existsSync(join(box.facts().workspace, "started"))).toBe(false);
			getOrThrow(await box.destroy(context));
		} finally {
			made.link.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("settles a stdin write or close made after the program exited", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const made = served(root);
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const program = getOrThrow(await box.exec(["true"], undefined, context));
			await Promise.all([readStream(program.stdout), readStream(program.stderr)]);
			expect(getOrThrow(await program.wait())).toBe(0);
			const late = (call: Promise<void>) =>
				Promise.race([
					call.then(() => "settled"),
					new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
				]);
			expect(await late(program.stdin.write(new TextEncoder().encode("too late")))).toBe("settled");
			expect(await late(program.stdin.close())).toBe("settled");
			getOrThrow(await box.destroy(context));
		} finally {
			made.link.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("acknowledges each call's last frames when it ends, so the host keeps no answer it already gave", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const server = serveBoxes({ providers: { local: localBoxes({ root }) } });
		const proxy = proxyBoxes(server.names);
		// What the runner sends the host, as the host reads it.
		const sent: Frame[] = [];
		const [runner, host] = linkPair();
		const toRunner = (frame: Frame) => host.send(frame);
		runner.onFrame((frame) => proxy.receive(frame));
		host.onFrame((frame) => {
			sent.push(frame);
			return server.receive(frame, toRunner);
		});
		proxy.up((frame) => runner.send(frame));
		try {
			const provider = proxy.providers.local as BoxProvider;
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 60_000 }, context));
			const path = join(box.facts().workspace, "file.txt");
			getOrThrow(await box.upload([{ path, bytes: new TextEncoder().encode("the file") }], context));
			expect(
				getOrThrow(await box.download([path], context)).map(({ bytes }) => new TextDecoder().decode(bytes)),
			).toEqual(["the file"]);
			const program = getOrThrow(await box.exec(["echo", "done"], undefined, context));
			await Promise.all([readStream(program.stdout), readStream(program.stderr)]);
			expect(getOrThrow(await program.wait())).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const asked = sent.filter(({ t }) => t === "box").map(({ id }) => id);
			const acked = new Set(sent.filter(({ t }) => t === "box-ack").map(({ id }) => id));
			expect(asked).toHaveLength(4);
			expect(asked.filter((id) => !acked.has(id))).toEqual([]);
			getOrThrow(await box.destroy(context));
		} finally {
			runner.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("ends at release a box whose create was still running, also one that finishes after the sweep began", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const local = localBoxes({ root });
		// A provider that takes its time to make a box and does not stop when the call is cancelled.
		const slow: BoxProvider = {
			name: "local",
			create: async (spec, at) => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				return local.create(spec, at);
			},
			attach: (id, at) => local.attach(id, at),
			list: (labels, at) => local.list(labels, at),
		};
		const server = serveBoxes({ providers: { local: slow } });
		const proxy = proxyBoxes(server.names);
		const link = connect(proxy, server);
		try {
			const asked = (proxy.providers.local as BoxProvider).create({ maxLifetimeMs: 60_000 }, context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			server.close();
			await server.release(context);
			// The closed host answers nothing more: the runner's call waits for a link that does not come back.
			void asked;
			await new Promise((resolve) => setTimeout(resolve, 500));
			// Nothing the host made is left running, and it holds nothing.
			expect(getOrThrow(await local.list({}, context))).toEqual([]);
			expect(server.held.size).toBe(0);
		} finally {
			link.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("applies a stdin write once when the runner sends it again, as it does after a resume whose ack was lost", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const server = serveBoxes({ providers: { local: localBoxes({ root }) } });
		const got: Frame[] = [];
		const reply = (frame: Frame) => {
			got.push(frame);
			return true;
		};
		const settled = async (until: (frames: Frame[]) => boolean) => {
			for (let n = 0; n < 200 && !until(got); n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		};
		try {
			server.receive(
				{ t: "box", id: "c1", op: "create", provider: "local", args: { spec: { maxLifetimeMs: 60_000 } } },
				reply,
			);
			await settled((frames) => frames.some((frame) => frame.id === "c1"));
			const label = (got.find((frame) => frame.id === "c1")?.value as { box: string }).box;
			server.receive(
				{ t: "box", id: "e1", op: "exec", provider: "local", box: label, args: { command: ["cat"] } },
				reply,
			);
			const bytes = Buffer.from("once").toString("base64");
			for (const frame of [
				{ t: "box-stdin", id: "e1", n: 1, bytes },
				{ t: "box-stdin", id: "e1", n: 1, bytes },
				{ t: "box-stdin", id: "e1", n: 2, close: true },
				{ t: "box-stdin", id: "e1", n: 1, bytes },
			])
				server.receive(frame, reply);
			await settled((frames) => frames.some((frame) => frame.id === "e1" && frame.exit !== undefined));
			const out = got
				.filter((frame) => frame.id === "e1" && frame.stream === "stdout")
				.map((frame) => Buffer.from(String(frame.bytes), "base64").toString())
				.join("");
			expect(out).toBe("once");
			expect(
				got.filter((frame) => frame.id === "e1" && typeof frame.stdin === "number").map((frame) => frame.stdin),
			).toEqual([1, 2]);
			await server.release(context);
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("says its providers in the link's hello, and refuses a box frame from a home the lease left behind", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const server = serveBoxes({ providers: { local: localBoxes({ root }) } });
		const [runner, hostEnd] = linkPair();
		const got: Frame[] = [];
		runner.onFrame((frame) => got.push(frame));
		const settled = async (until: () => boolean) => {
			for (let n = 0; n < 200 && !until(); n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		};
		const host = connectHome(hostEnd, { models: createModels(), epoch: 2, boxes: server });
		try {
			await settled(() => got.some((frame) => frame.t === "hello"));
			expect(got.find((frame) => frame.t === "hello")?.boxes).toEqual(["local"]);
			const ask = { t: "box", op: "create", provider: "local", args: { spec: { maxLifetimeMs: 60_000 } } };
			runner.send({ ...ask, id: "old", epoch: 1 });
			await settled(() => got.some((frame) => frame.t === "refused"));
			expect(got.some((frame) => frame.t === "refused")).toBe(true);
			expect(server.held.size).toBe(0);
			runner.send({ ...ask, id: "now", epoch: 2 });
			await settled(() => got.some((frame) => frame.id === "now"));
			expect(got.find((frame) => frame.id === "now")?.ok).toBe(true);
			expect(server.held.size).toBe(1);
			await server.release(context);
		} finally {
			host.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("refuses a box the host's policy does not allow, and a provider it does not serve", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-boxes-"));
		const server = serveBoxes({
			providers: { local: localBoxes({ root }) },
			allow: (_provider, spec) => (spec.gpu === undefined ? undefined : "this session gets no GPU"),
		});
		const proxy = proxyBoxes([...server.names, "elsewhere"]);
		const link = connect(proxy, server);
		try {
			const refused = await proxy.providers.local?.create({ maxLifetimeMs: 60_000, gpu: "T4" }, context);
			expect(refused?.ok ? "made" : refused?.error.code).toBe("invalid");
			const unknown = await proxy.providers.elsewhere?.create({ maxLifetimeMs: 60_000 }, context);
			expect(unknown?.ok ? "made" : unknown?.error.code).toBe("invalid");
			expect(server.held.size).toBe(0);
		} finally {
			link.close("done");
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});
});
