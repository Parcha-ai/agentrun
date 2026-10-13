import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import { BoxError } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { parseTransportConfig } from "../src/config.ts";
import { transport } from "../src/hands/index.ts";
import { HandsDoc, TransportError } from "../src/transport.ts";
import { bash, openSession, registerHandsCases, type WatchedProvider, watched } from "./hands-support.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `use` with a watched local provider in a directory of its own, and ends every box it created. */
async function withLocal(use: (provider: WatchedProvider, directory: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-hands-"));
	const provider = watched(localBoxes({ root: join(directory, "boxes") }));
	try {
		await use(provider, directory);
	} finally {
		for (const box of provider.created) await box.destroy(context);
		rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

const SANDBOX = { environments: { sandbox: { provider: "local" } }, hands: "sandbox" };

registerHandsCases(
	"hands on local boxes",
	async (use) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-hands-"));
		try {
			await use({
				provider: () => localBoxes({ root: join(directory, "boxes") }),
				environment: { provider: "local" },
				directory,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	60_000,
);

describe("transport(): what it refuses at start", () => {
	const host = { providers: {}, commit: () => Promise.reject(new Error("not used")) };
	const refusal = (config: unknown, providers: Record<string, WatchedProvider> = {}) => {
		try {
			transport(getOrThrow(parseTransportConfig(config)), { ...host, providers });
		} catch (error) {
			return error;
		}
		return undefined;
	};

	it("refuses an environment with expose: no secret is passed into a box in this release", () => {
		const error = refusal({
			environments: { sandbox: { provider: "local", expose: ["API_KEY"] } },
			hands: "sandbox",
		});
		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).code).toBe("unsupported");
		expect((error as TransportError).message).toMatch(/"sandbox" has expose, which is not available yet/);
	});

	it("refuses an environment whose provider the host did not pass, but not local", () => {
		const remote = { environments: { far: { provider: "elsewhere", maxLifetime: "1h" } }, hands: "far" };
		expect((refusal(remote) as TransportError).code).toBe("unknown_provider");
		expect((refusal(remote) as TransportError).message).toMatch(/"far" names the provider "elsewhere"/);
		expect(refusal(SANDBOX)).toBeUndefined();
	});

	it("refuses hands that are left to a classifier, which this release does not have", () => {
		const auto = {
			environments: { sandbox: { provider: "local" } },
			hands: "auto",
			auto: { classifier: { provider: "p", modelId: "m" } },
		};
		expect((refusal(auto) as TransportError).code).toBe("unsupported");
	});
});

describe("transport(): where tools run", () => {
	it("leaves tools with the host when the config names no hands, or names local and the host has no local provider", async () => {
		await withLocal(async (provider) => {
			for (const [config, providers] of [
				[{ environments: { sandbox: { provider: "local" } } }, { local: provider }],
				[SANDBOX, {}],
			] as const) {
				const session = await openSession(new MemoryStorage(), config, providers);
				const conversation = await session.converse();
				expect(
					await session.hands.env({ conversationId: conversation.id, read: session.harness }, context),
				).toBeUndefined();
				await session.harness.close(context);
			}
			expect(provider.specs).toEqual([]);
		});
	});

	it("is lazy: an environment with no box yet names no box, and a command started in it runs in the box's own directory", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const env = (await session.hands.env(
				{ conversationId: conversation.id, read: session.harness },
				context,
			)) as ExecutionEnv;
			expect(env.id).toBe("pi-transport:sandbox:unopened");
			expect(env.cwd).toBe(".");
			expect(getOrThrow(await env.joinPath(["a", "..", "b"], context))).toBe("b");
			expect(provider.specs).toEqual([]);

			let output = "";
			const collect = (text: string) => {
				output += text;
			};
			getOrThrow(await env.exec(["pwd"], { cwd: env.cwd, onOutput: collect }, context));
			const box = provider.created[0];
			expect(output.trim()).toBe(box?.facts().workspace);
			expect(env.id).toBe(`pi-transport:local:${box?.id}`);
			expect(env.cwd).toBe(box?.facts().workspace);
			await session.harness.close(context);
		});
	});

	it("creates one box for first uses that come at the same time", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversations = [await session.converse(), await session.converse(), await session.converse()];
			const envs = await Promise.all(
				conversations.map((conversation) =>
					session.hands.env({ conversationId: conversation.id, read: session.harness }, context),
				),
			);
			const results = await Promise.all(envs.map((env) => (env as ExecutionEnv).exec(["true"], undefined, context)));
			expect(results.map((result) => result.ok)).toEqual([true, true, true]);
			expect(provider.created.length).toBe(1);
			expect(new Set(envs.map((env) => env?.id)).size).toBe(1);
			await session.harness.close(context);
		});
	});

	it("reports a box that cannot be created as that call's error with the provider's code, and asks again at the next call", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			provider.refuseNext(new BoxError("capacity", "no machine left"));
			const outcomes = await session.turn(await session.converse(), [bash("echo one"), bash("echo two")]);
			expect(outcomes[0]?.isError).toBe(true);
			expect(outcomes[0]?.text).toContain(
				'could not create a box for environment "sandbox": [capacity] no machine left',
			);
			expect(outcomes[1]?.isError).toBe(false);
			expect(outcomes[1]?.text).toContain("two");
			expect(provider.specs.length).toBe(2);
			await session.harness.close(context);
		});
	});

	it("fails a command with unknown, never spawn_error, and a file operation with unknown, when no box can be had", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const env = (await session.hands.env(
				{ conversationId: conversation.id, read: session.harness },
				context,
			)) as ExecutionEnv;
			provider.refuseNext(new BoxError("unauthorized", "the key was refused"));
			const ran = await env.exec(["true"], undefined, context);
			// pi's bash tool runs the next form of a command after a spawn error, and each form would ask for a box.
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toContain("[unauthorized] the key was refused");
			provider.refuseNext(new BoxError("capacity", "no machine left"));
			const read = await env.readTextFile("a.txt", context);
			expect(read.ok ? "" : read.error.code).toBe("unknown");
			expect(provider.created).toEqual([]);
			await session.harness.close(context);
		});
	});

	it("ends a box it could not record, and fails the call that needed it", async () => {
		await withLocal(async (provider) => {
			let failing = true;
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider }, undefined, (inner) => {
				return (change, commitContext) => {
					if (!failing) return inner(change, commitContext);
					failing = false;
					return Promise.reject(new Error("the store refused the write"));
				};
			});
			const outcomes = await session.turn(await session.converse(), [bash("echo one"), bash("echo two")]);
			expect(outcomes[0]?.isError).toBe(true);
			expect(outcomes[0]?.text).toMatch(/could not record box local-[0-9a-f]+: the store refused the write/);
			expect(outcomes[1]?.text).toContain("two");
			expect(provider.created.length).toBe(2);
			const [unrecorded] = provider.created;
			if (unrecorded === undefined) throw new Error("no box was created");
			expect(getOrThrow(await unrecorded.status(context)).state).toBe("ended");
			await session.harness.close(context);
		});
	});

	it("ends the boxes it has in hand even when the session's documents cannot be read", async () => {
		await withLocal(async (provider) => {
			let failing = false;
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider }, undefined, (inner) => {
				return (change, commitContext) =>
					failing ? Promise.reject(new Error("the store is closed")) : inner(change, commitContext);
			});
			expect((await session.turn(await session.converse(), [bash("true")]))[0]?.isError).toBe(false);
			const [box] = provider.created;
			if (box === undefined) throw new Error("no box was created");
			failing = true;
			const destroyed = await session.hands.destroy(context);
			expect(destroyed.ok ? "" : destroyed.error.code).toBe("store");
			expect(getOrThrow(await box.status(context)).state).toBe("ended");
			await session.harness.close(context);
		});
	});

	it("labels every box and hands the environment's settings and the workspace to the provider", async () => {
		await withLocal(async (provider, directory) => {
			const workspace = join(directory, "workspace");
			const config = {
				environments: {
					sandbox: { provider: "local", image: "tools:1", cpus: 2, memoryMb: 512, env: { MODE: "test" } },
				},
				hands: "sandbox",
				workspace: { path: workspace },
			};
			const session = await openSession(
				new MemoryStorage(),
				config,
				{ local: provider },
				{ team: "docs", "pi-transport": "no" },
			);
			expect((await session.turn(await session.converse(), [bash("echo $MODE")]))[0]?.text).toContain("test");
			expect(provider.specs).toEqual([
				{
					maxLifetimeMs: 24 * 3_600_000,
					labels: { team: "docs", "pi-transport": "1" },
					env: { MODE: "test" },
					image: "tools:1",
					cpus: 2,
					memoryMb: 512,
					workspace,
				},
			]);
			await session.harness.close(context);
		});
	});

	it("follows the agent's directory only inside the box's workspace", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const target = { conversationId: conversation.id, read: session.harness };
			const first = (await session.hands.env(target, context)) as ExecutionEnv;
			const workspace = getOrThrow(await first.absolutePath(".", context));
			mkdirSync(join(workspace, "sub"));
			const inside = (await session.hands.env({ ...target, cwd: join(workspace, "sub") }, context)) as ExecutionEnv;
			expect(getOrThrow(await inside.absolutePath("x", context))).toBe(join(workspace, "sub", "x"));
			const outside = (await session.hands.env({ ...target, cwd: "/a/path/of/the/host" }, context)) as ExecutionEnv;
			expect(getOrThrow(await outside.absolutePath("x", context))).toBe(join(workspace, "x"));
			expect(provider.created.length).toBe(1);
			await session.harness.close(context);
		});
	});

	it("gives a fork the default environment, not its parent's assignment", async () => {
		await withLocal(async (provider) => {
			const config = {
				environments: { sandbox: { provider: "local" }, other: { provider: "local" } },
				hands: { default: "sandbox", build: "other" },
			};
			const session = await openSession(new MemoryStorage(), config, { local: provider });
			const parent = await session.converse();
			expect((await session.turn(parent, [bash("echo default > where.txt")]))[0]?.isError).toBe(false);
			getOrThrow(await session.hands.assign(parent.id, "build", context));
			const newest = (await parent.entries({}, 1, undefined, context)).items[0];
			if (newest === undefined) throw new Error("the conversation has no entry");
			const fork = await parent.fork(newest.id, { ownership: { kind: "ownerless" } }, context);
			expect(await session.harness.snapshot(HandsDoc, parent.id, context)).toEqual({ environment: "other" });
			expect((await session.harness.snapshot(HandsDoc, fork.id, context))?.environment).toBeUndefined();
			expect((await session.turn(fork, [bash("cat where.txt")]))[0]?.text).toContain("default");
			await session.harness.close(context);
		});
	});

	it("stops the commands it still runs on release, and leaves the box", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const env = (await session.hands.env(
				{ conversationId: conversation.id, read: session.harness },
				context,
			)) as ExecutionEnv;
			const tag = `pi-transport-release-${process.pid}-${Date.now()}`;
			const running = () => spawnSync("pgrep", ["-f", tag]).stdout.toString().trim() !== "";
			const pending = env.exec(`sleep 30 & sleep 30 # ${tag}\nwait`, undefined, context);
			for (let tries = 0; !running(); tries++) {
				if (tries > 200) throw new Error("the command did not start");
				await sleep(50);
			}
			await session.hands.release(context);
			expect(getOrThrow(await pending).exitCode).toBeGreaterThan(128);
			expect(running()).toBe(false);
			const box = provider.created[0];
			if (box === undefined) throw new Error("no box was created");
			expect(getOrThrow(await box.status(context)).state).toBe("running");
			await session.harness.close(context);
		});
	});
});

describe("what the router leans on in pi", () => {
	// The router records a box's id with the Harness's `commit` while a tool call is under way, and reads documents
	// inside `env`. pi says `env` is never called on the Session line; this holds it to that on the version in use.
	it("lets an environment function commit to the session before a tool runs", async () => {
		const Count = defineDoc<{ commits: number }>({
			kind: "test.env-commits",
			version: 1,
			scope: "session",
			initial: () => ({ commits: 0 }),
		});
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-hands-"));
		try {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const registry = createRegistry();
			registry.install(CodingTools);
			let harness: Harness | undefined;
			harness = await Harness.open(
				new MemoryStorage(),
				{
					models,
					registry,
					env: async (_target, envContext) => {
						await (harness as Harness).commit(async (tx) => {
							(await tx.doc(Count)).commits += 1;
						}, envContext);
						return new NodeExecutionEnv({ cwd: directory });
					},
				},
				context,
			);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo ran" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			]);
			const model = { provider: "faux", modelId: faux.getModel().id };
			const conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model } },
				context,
			);
			await (await conversation.submit({ type: "input", content: "Go on." }, context)).wait(context);
			// Once for each of the two prompts, and once for the tool call.
			expect((await harness.snapshot(Count, context))?.commits).toBe(3);
			await harness.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
