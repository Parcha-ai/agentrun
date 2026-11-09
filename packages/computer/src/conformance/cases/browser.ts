// The browser case set: what a computer of kind browser must do, on one browser for the whole run (the run's shared
// computer, made with the run's labels), so a live run costs one vendor session. check refuses a lifetime past the cap
// and create makes nothing; attach finds the browser by id and by labels, and list by labels; connect hands over a CDP
// URL that answers Browser.getVersion, navigates to a data: URL and evaluates on it; the live view is there; and,
// last, release is idempotent and attach, connect and ping after it fail in words. No error, result or report carries
// the CDP URL.
import type { ComputerRef } from "../../provider.js";
import type { Case, CaseContext } from "../types.js";
import { healthCases } from "./health.js";

const PAGE = '<title>agentrun conformance</title><p id="x">42</p>';
const DATA_URL = `data:text/html,${encodeURIComponent(PAGE)}`;
const READ = 'document.title + " " + document.getElementById("x").textContent';
const EXPECTED = "agentrun conformance 42";

const refOf = ({ id, name }: ComputerRef): ComputerRef => ({ id, name });

/** promise, or a failure naming what did not come within ms: a bound, never a claim about speed. */
async function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not come within ${ms / 1000} s`)), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/** The browser's CDP URL, from a connection of the case's own; a secret, never put in an assertion's words. */
async function cdpUrl(t: CaseContext, ref?: ComputerRef): Promise<string> {
	const connection = await t.connect(ref);
	const url = connection.cdp?.url;
	t.assert(typeof url === "string" && /^wss?:\/\//.test(url), "connect gives cdp.url, a ws:// or wss:// URL");
	return url as string;
}

/** Fails the case when text carries the secret, without saying the secret. */
const noSecret = (t: CaseContext, text: string, secret: string, what: string) => t.assert(!text.includes(secret), `${what} carries the CDP URL`);

const browser = (name: string, run: Case["run"], extra: Partial<Case> = {}): Case => ({ id: `browser.${name}`, level: "core", group: "browser", needs: [], run, ...extra });

export const browserOnlyCases: Case[] = [
	browser(
		"check-refuses",
		async (t) => {
			const { maxLifetimeMs } = t.provider.capabilities();
			t.deepEqual(t.provider.check(t.spec()), [], "check of the run's own spec");
			const past = t.spec({ lifetimeMs: maxLifetimeMs + 1 });
			const refusals = t.provider.check(past);
			t.assert(refusals.some((r) => r.field === "lifetimeMs"), `check refuses lifetimeMs ${maxLifetimeMs + 1}, past maxLifetimeMs`);
			const error = t.refused(await t.attempt(past), "create past maxLifetimeMs", ["refused"]);
			t.assert(
				refusals.some(({ message }) => error.message.includes(message)),
				`create's refusal names what check() refused (${refusals.map((r) => r.message).join("; ")}), not: ${error.message}`,
			);
		},
		{ computer: "none" },
	),
	browser("labels", async (t) => {
		const byId = t.ok(await t.provider.attach({ id: t.ref.id }), "attach by id");
		t.deepEqual(refOf(byId), refOf(t.ref), "attach by id finds the run's browser");
		t.equal(byId.spec.kind, "browser", "attach reads the computer back as a browser");
		const byLabels = t.ok(await t.provider.attach({ labels: t.runLabels }), `attach by labels ${JSON.stringify(t.runLabels)}`);
		t.deepEqual(refOf(byLabels), refOf(t.ref), "attach by the run's labels finds the run's browser");
		const listed = t.ok(await t.provider.list(t.runLabels), "list");
		t.deepEqual(listed.map((info) => refOf(info.ref)), [refOf(t.ref)], "list by the run's labels: the run's browser alone");
		const [info] = listed;
		t.equal(info?.state, "running", "the listed browser's state");
		for (const [key, value] of Object.entries(t.runLabels)) t.equal(info?.labels[key], value, `the listed browser's label ${key}, read back from the vendor`);
	}),
	browser(
		"cdp",
		async (t) => {
			t.equal(t.hello.kind, "browser", "hello's kind");
			t.assert(t.hello.groups.includes("cdp"), "hello declares cdp");
			const cdp = await t.cdp(await cdpUrl(t));
			const version = await cdp.send<{ product?: unknown; protocolVersion?: unknown }>("Browser.getVersion");
			t.assert(typeof version.product === "string" && version.product !== "", `Browser.getVersion names a product, not ${JSON.stringify(version.product)}`);
			const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
			try {
				const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
				await cdp.send("Page.enable", {}, sessionId);
				// Asked before the navigate, so a load that comes before navigate's answer is not missed.
				const loaded = cdp.event("Page.loadEventFired", sessionId);
				// Handled at once: a navigate that fails leaves before the await below, and the socket's close at the case's
				// end then rejects the event, which must not go unhandled. The await still sees a rejection.
				loaded.catch(() => undefined);
				const navigated = await cdp.send<{ errorText?: string }>("Page.navigate", { url: DATA_URL }, sessionId);
				t.assert(navigated.errorText === undefined, `Page.navigate to a data: URL failed: ${navigated.errorText}`);
				await bounded(loaded, t.patience, "Page.loadEventFired after the navigate to the data: page");
				const evaluated = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: READ, returnByValue: true }, sessionId);
				t.equal(evaluated.result?.value, EXPECTED, "Runtime.evaluate on the data: page");
			} finally {
				await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
			}
		},
		{ needs: ["cdp"] },
	),
	browser(
		"stream",
		async (t) => {
			const stream = t.provider.stream;
			if (stream === undefined) return t.skip("the provider has no stream()");
			const view = t.ok(await stream.call(t.provider, t.ref, {}, { signal: t.signal }), "stream");
			t.assert(typeof view.url === "string" && /^https:\/\//.test(view.url), "stream gives the live view's URL, an https:// URL");
			noSecret(t, JSON.stringify(t.ok(await t.provider.list(t.runLabels), "list")), view.url, "list, beside the stream");
		},
		{ level: "full", needs: ["stream"] },
	),
	// Last: it ends the run's one browser, which the runner releases again at the run's end (a second release, which must
	// be ok).
	browser("release", async (t) => {
		const secret = await cdpUrl(t);
		const before = await t.connect();
		t.ok(await t.provider.release(t.ref, "delete"), "release");
		t.ok(await t.provider.release(t.ref, "delete"), "a second release of the same browser");
		const failures = {
			"attach by id after release": await t.provider.attach({ id: t.ref.id }),
			"attach by labels after release": await t.provider.attach({ labels: t.runLabels }),
			"connect after release": await t.provider.connect(t.ref),
			"ping after release": await before.client.call("ping", {}),
		};
		for (const [what, result] of Object.entries(failures)) {
			const error = t.refused(result, what);
			t.assert(error.message.trim() !== "", `${what}: the refusal is in words`);
			noSecret(t, error.message, secret, what);
		}
		t.deepEqual(t.ok(await t.provider.list(t.runLabels), "list after release"), [], "list by the run's labels after release");
	}),
];

/** What the CLI runs for a browser: the health cases (hello and ping from the provider, the kind consistent), then these. */
export const browserCases: Case[] = [...healthCases, ...browserOnlyCases];
