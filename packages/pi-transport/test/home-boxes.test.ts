import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { BoxProvider } from "../src/box/box.ts";
import { readStream } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { type BoxServer, type ProxyBoxes, proxyBoxes, serveBoxes } from "../src/home/boxes.ts";
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
