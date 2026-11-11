// The local browser on a real Chrome: runs only where a Chrome or Chromium is on PATH (or CHROME_PATH names one) and
// starts here with its sandbox on, and skips with the reason otherwise. It creates a browser, connects over CDP, opens
// about:blank in a new tab and reads it back, finds a service on this machine's loopback out of the page's reach (the
// fence), and releases the browser, leaving no Chrome and no profile.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after } from "node:test";
import { checkChrome, findChrome } from "../dist/chrome.js";
import { LocalBrowserProvider } from "../dist/local.js";

const chrome = findChrome({ PATH: process.env.PATH, CHROME_PATH: process.env.CHROME_PATH });
const checked = chrome ? await checkChrome(chrome) : undefined;
const skip = chrome === null ? "no Chrome or Chromium on PATH (or CHROME_PATH)" : checked.ok ? false : `Chrome is here but cannot start a local browser: ${checked.error.message}`;
const root = mkdtempSync(join("/tmp", "lbl-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A CDP client over one websocket: send(method, params, sessionId) answers the result, or throws the error. */
async function cdp(url) {
	const socket = new WebSocket(url);
	await new Promise((done, failed) => {
		socket.onopen = done;
		socket.onerror = () => failed(new Error("the DevTools socket did not open"));
	});
	let next = 0;
	const waiting = new Map();
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data));
		const pending = waiting.get(message.id);
		if (!pending) return;
		waiting.delete(message.id);
		if (message.error) pending.failed(new Error(message.error.message));
		else pending.done(message.result);
	};
	return {
		send: (method, params = {}, sessionId) =>
			new Promise((done, failed) => {
				const id = ++next;
				waiting.set(id, { done, failed });
				socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			}),
		close: () => socket.close(),
	};
}

test("a real Chrome: create, connect over CDP, open about:blank, the fence holds, release leaves nothing", { skip, timeout: 120_000 }, async () => {
	const provider = new LocalBrowserProvider({ executablePath: chrome, root });
	const made = await provider.create({ image: "chromium", lifetimeMs: 120_000, network: "open", labels: { "agentrun.test": "live" } });
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	const dir = join(root, made.value.id);
	try {
		const connected = await provider.connect(made.value);
		assert.ok(connected.ok, connected.ok ? "" : connected.error.message);
		assert.match(connected.value.cdp.url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//); // key-gate: loopback-rule the local Chrome's DevTools socket
		const browser = await cdp(connected.value.cdp.url);
		try {
			const version = await browser.send("Browser.getVersion");
			assert.match(version.product, /Chrome|Chromium/);
			const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
			const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
			const href = await browser.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
			assert.equal(href.result.value, "about:blank");
			// A service on this machine's loopback: the page cannot reach it, since the proxy refuses loopback.
			const local = createServer((_req, res) => res.end("LOCAL-SERVICE-REACHED"));
			await new Promise((done) => local.listen(0, "127.0.0.1", done)); // key-gate: loopback-rule a test's own service the fence must refuse
			try {
				const navigated = await browser.send("Page.navigate", { url: `http://127.0.0.1:${local.address().port}/` }, sessionId); // key-gate: loopback-rule a test's own service the fence must refuse
				// The proxy answers a plain-http request it refuses with its own 403 page, so the navigation commits to that page.
				const body = await browser.send("Runtime.evaluate", { expression: "new Promise((done) => { const read = () => document.readyState === 'complete' ? done(document.body ? document.body.innerText : '') : setTimeout(read, 50); read(); })", awaitPromise: true, returnByValue: true }, sessionId);
				const shown = String(body.result.value);
				assert.doesNotMatch(shown, /LOCAL-SERVICE-REACHED/, "the service on loopback was not reached");
				assert.ok(navigated.errorText || /refused/i.test(shown), `the proxy refused it: ${navigated.errorText ?? shown}`);
			} finally {
				local.close();
			}
		} finally {
			browser.close();
		}
		assert.deepEqual((await provider.list({ "agentrun.test": "live" })).value.map((one) => one.state), ["running"]);
	} finally {
		const released = await provider.release(made.value, "delete");
		assert.ok(released.ok, released.ok ? "" : released.error.message);
	}
	assert.equal(existsSync(dir), false, "no profile left");
	assert.deepEqual((await provider.list({})).value, [], "no browser left");
});
