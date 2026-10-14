import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { type Frame, type Link, linkPair } from "../src/home/link.ts";
import { catalogOf, type ModelServer, type ProxyModels, proxyModels, serveModels } from "../src/home/models.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Join a runner's proxy and the host's server over a fresh pair of links. Returns the runner's end, to cut. */
function connect(proxy: ProxyModels, server: ModelServer): Link {
	const [runner, host] = linkPair();
	const toRunner = (frame: Frame) => host.send(frame);
	runner.onFrame((frame) => proxy.receive(frame));
	host.onFrame((frame) => server.receive(frame, toRunner));
	runner.onClose((reason) => proxy.down(reason));
	host.onClose(() => server.down());
	server.up(toRunner);
	proxy.up((frame) => runner.send(frame));
	return runner;
}

/** The host's models: every call is paid, and each answer says which call it was. */
function host(options?: { tokensPerSecond?: number }) {
	const faux = fauxProvider({ api: "faux", ...options });
	const models = createModels();
	models.setProvider(faux.provider);
	let calls = 0;
	faux.setResponses(
		Array.from({ length: 20 }, () => () => {
			calls += 1;
			return fauxAssistantMessage(`answer number ${calls}`);
		}),
	);
	return { models, calls: () => calls };
}

const text = (message: AssistantMessage) =>
	message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** A runner process: a new proxy, every request keyed by its body and the position the caller names. */
function runner(position: number, keep = (body: string) => body) {
	return proxyModels(catalogOf(host().models), {
		keyOf: ({ messages }) => ({ key: `s/${keep(JSON.stringify(messages))}`, position }),
	});
}

const ask = (proxy: ProxyModels, content: string) => {
	const model = proxy.models.getModel("faux", "faux-1");
	if (model === undefined) throw new Error("no faux model in the catalog");
	const messages: Message[] = [{ role: "user", content, timestamp: 1 }];
	return proxy.models.completeSimple(model, { messages });
};

describe("the host's paid answers across a lost box", () => {
	it("answers the repeat from a restored runner with the same answer and pays once, long after keepMs", async () => {
		const paying = host();
		const server = serveModels(paying.models, { keepMs: 20 });
		const first = runner(7);
		const link = connect(first, server);
		const answer = await ask(first, "the question");
		expect(text(answer)).toBe("answer number 1");
		// The box is killed: the runner is gone with its link. The host keeps its server.
		link.close("the box was destroyed");
		await sleep(80);
		const restored = runner(7);
		connect(restored, server);
		const again = await ask(restored, "the question");
		expect(text(again)).toBe("answer number 1");
		expect(paying.calls()).toBe(1);
		expect(server.paid).toBe(1);
		expect(server.kept).toBe(1);
	});

	it("lets a repeat join the call that is still streaming when the box is killed, and pays once", async () => {
		const paying = host({ tokensPerSecond: 20 });
		const server = serveModels(paying.models);
		const first = runner(3);
		const link = connect(first, server);
		const pending = ask(first, "a slow question");
		pending.catch(() => undefined);
		await sleep(30);
		link.close("the box was destroyed");
		const restored = runner(3);
		connect(restored, server);
		const again = await ask(restored, "a slow question");
		expect(text(again)).toBe("answer number 1");
		expect(paying.calls()).toBe(1);
		expect(server.paid).toBe(1);
	});

	it("pays again for a different question, and for the same one at another key", async () => {
		const paying = host();
		const server = serveModels(paying.models);
		const proxy = runner(1);
		connect(proxy, server);
		await ask(proxy, "one");
		await ask(proxy, "two");
		expect(server.paid).toBe(2);
		const other = proxyModels(catalogOf(paying.models), {
			keyOf: ({ messages }) => ({ key: `other/${JSON.stringify(messages)}`, position: 1 }),
		});
		connect(other, server);
		await ask(other, "one");
		expect(server.paid).toBe(3);
	});

	it("lets the answers a checkpoint covers go, and pays again for them", async () => {
		const paying = host();
		const server = serveModels(paying.models);
		const early = runner(4);
		connect(early, server);
		await ask(early, "early");
		const late = runner(9);
		connect(late, server);
		await ask(late, "late");
		expect(server.kept).toBe(2);
		// A checkpoint whose head is 9 covers what was asked at position 4, not what was asked at 9.
		server.covered(9);
		expect(server.kept).toBe(1);
		const again = runner(4);
		connect(again, server);
		await ask(again, "early");
		expect(server.paid).toBe(3);
		const stillKept = runner(9);
		connect(stillKept, server);
		await ask(stillKept, "late");
		expect(server.paid).toBe(3);
	});

	it("does not keep a failure for its key: asking again is how a caller retries", async () => {
		const faux = fauxProvider({ api: "faux" });
		const models = createModels();
		models.setProvider(faux.provider);
		let calls = 0;
		faux.setResponses([
			() => {
				calls += 1;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
			},
			() => {
				calls += 1;
				return fauxAssistantMessage("recovered");
			},
		]);
		const server = serveModels(models);
		const first = runner(1);
		connect(first, server);
		const failed = await ask(first, "q");
		expect(failed.stopReason).toBe("error");
		expect(server.kept).toBe(0);
		const retry = runner(1);
		connect(retry, server);
		const answered = await ask(retry, "q");
		expect(text(answered)).toBe("recovered");
		expect(calls).toBe(2);
	});

	it("pays for every request that names no key, as before", async () => {
		const paying = host();
		const server = serveModels(paying.models);
		const proxy = proxyModels(catalogOf(paying.models));
		connect(proxy, server);
		await ask(proxy, "same");
		await ask(proxy, "same");
		expect(server.paid).toBe(2);
		expect(server.kept).toBe(0);
	});
});
