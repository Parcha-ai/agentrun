// Fakes of the two browser vendors' REST APIs, as an injected fetch, and of a browser's CDP socket, as an injected
// dialer, for the browser providers' unit tests and their conformance run. Nothing reaches a network: the hosts are under
// .test, which never resolves, and no socket is opened.
//
// Browserbase (api.browserbase.test), as its v1 API answers and @browserbasehq/sdk 2.x calls it: POST /v1/sessions makes
// a RUNNING session with a signed connectUrl and keeps userMetadata; GET /v1/sessions/{id} reads one (404: unknown);
// a userMetadata key with a "." is refused with 400, as Browserbase answered live on 11-08;
// GET /v1/sessions?status=&q= lists by status, q being user_metadata['key']:'value'; POST /v1/sessions/{id} with
// status REQUEST_RELEASE ends one (COMPLETED, still readable); GET /v1/sessions/{id}/debug gives the live view's URLs.
// The key is the X-BB-API-Key header.
//
// Kernel (api.kernel.test), as pi-browser's Kernel provider calls it today: POST /browsers makes a browser with a CDP and
// a live-view URL and keeps its tags; GET /browsers/{id} reads one (404 once deleted); GET /browsers?status=active&
// tags[key]=value&limit&offset pages by X-Has-More and X-Next-Offset; DELETE /browsers/{id} ends one (404: unknown).
// The key is a bearer token.
//
// Every URL a fake hands out carries a SECRET- token, so a test can show none of them reaches a ref, a list, an error or
// a report.

export const BROWSERBASE_URL = "https://api.browserbase.test";
export const KERNEL_URL = "https://api.kernel.test";
export const BROWSERBASE_KEY = "bb_fake_key_for_tests";
export const KERNEL_KEY = "kernel_fake_key_for_tests";
/** Text a vendor echoes into an error body: an error that copies the vendor's words would carry it. */
export const ECHO = "VENDOR-ECHO-SECRET";

const json = (status, body, headers = {}) =>
	new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake browser's state, shared by the vendor that made it and the CDP dialer that drives it. */
function browsers() {
	/** url → { alive(): boolean } */
	const byUrl = new Map();
	return {
		add(url, alive) {
			byUrl.set(url, { alive });
		},
		alive(url) {
			return byUrl.get(url)?.alive() === true;
		},
	};
}

/**
 * A fake CDP dialer for every browser a fake vendor made: it opens only a running browser's URL, and answers
 * Browser.getVersion, Target.createTarget, Target.attachToTarget, Target.closeTarget, Page.enable, Page.navigate (a data:
 * URL's HTML becomes the page, and Page.loadEventFired follows the answer, as Chrome sends it) and Runtime.evaluate
 * (the page's title, and #x's text, read from that HTML).
 */
function cdpDialer(known, knobs) {
	const dialed = [];
	const dial = async (url) => {
		dialed.push(url);
		if (!known.alive(url)) throw new Error("the CDP socket could not be opened");
		const pages = new Map();
		const sessions = new Map();
		const enabled = new Set();
		const waiting = [];
		const emit = (method, sessionId, params = {}) => {
			const at = waiting.findIndex((w) => w.method === method && (w.sessionId === undefined || w.sessionId === sessionId));
			if (at >= 0) waiting.splice(at, 1)[0].resolve(params);
		};
		let next = 0;
		let open = true;
		return {
			event(method, sessionId) {
				return new Promise((resolve, reject) => (open ? waiting.push({ method, sessionId, resolve }) : reject(new Error(`CDP ${method}: the socket is closed`))));
			},
			async send(method, params = {}, sessionId) {
				if (!open) throw new Error(`CDP ${method}: the socket is closed`);
				switch (method) {
					case "Browser.getVersion":
						return { protocolVersion: "1.3", product: knobs.product ?? "Chrome/140.0.0.0", revision: "@fake", userAgent: "Mozilla/5.0 fake", jsVersion: "14.0" };
					case "Target.createTarget": {
						const targetId = `T${++next}`;
						pages.set(targetId, { html: "" });
						return { targetId };
					}
					case "Target.attachToTarget": {
						if (!pages.has(params.targetId)) throw new Error("CDP Target.attachToTarget: No target with given id found");
						const id = `S${++next}`;
						sessions.set(id, params.targetId);
						return { sessionId: id };
					}
					case "Page.enable":
						enabled.add(sessionId);
						return {};
					case "Target.closeTarget":
						pages.delete(params.targetId);
						return { success: true };
					case "Page.navigate": {
						const page = pages.get(sessions.get(sessionId));
						if (page === undefined) throw new Error("CDP Page.navigate: no such session");
						if (!params.url.startsWith("data:text/html,")) return { frameId: "F", errorText: "net::ERR_FAILED" };
						page.html = decodeURIComponent(params.url.slice("data:text/html,".length));
						// As Chrome does: the load event comes after the navigate is answered, to a session that enabled Page.
						if (enabled.has(sessionId)) queueMicrotask(() => emit("Page.loadEventFired", sessionId, { timestamp: 1 }));
						return { frameId: "F", loaderId: "L" };
					}
					case "Runtime.evaluate": {
						const page = pages.get(sessions.get(sessionId));
						if (page === undefined) throw new Error("CDP Runtime.evaluate: no such session");
						const title = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? "";
						const x = /<p id="x">([^<]*)<\/p>/.exec(page.html)?.[1] ?? "";
						const value = `${knobs.title ?? title} ${x}`;
						return { result: { type: "string", value } };
					}
					default:
						throw new Error(`CDP ${method}: 'Method not found'`);
				}
			},
			close() {
				open = false;
			},
		};
	};
	return { dial, dialed };
}

/** Records each request; answers 401 to a wrong key. */
function recorder(base) {
	const calls = [];
	return {
		calls,
		async read(input, init = {}) {
			const url = new URL(String(input));
			if (`${url.protocol}//${url.host}` !== base) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND (the fake knows only its own host)");
			if (init.signal?.aborted) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
			const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
			const call = { method: init.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...init.headers }, body };
			calls.push(call);
			return call;
		},
		only(method, path) {
			return calls.filter((c) => c.method === method && (path instanceof RegExp ? path.test(c.path) : c.path === path));
		},
	};
}

/**
 * A fake Browserbase. knobs: failCreate (a status the create answers, with ECHO in its body), releaseLag (reads that
 * still say RUNNING after a release), product and title (what the fake browser says).
 */
export function fakeBrowserbase(knobs = {}) {
	const rec = recorder(BROWSERBASE_URL);
	const known = browsers();
	const cdp = cdpDialer(known, knobs);
	const sessions = new Map();
	let seq = 0;
	const view = (s) => ({
		id: s.id,
		status: s.status,
		projectId: "proj_fake",
		createdAt: s.createdAt,
		expiresAt: s.expiresAt,
		keepAlive: s.keepAlive,
		userMetadata: { ...s.userMetadata },
		connectUrl: s.connectUrl,
	});
	const lagging = (s) => {
		if (s.lag > 0) {
			s.lag--;
			return { ...view(s), status: "RUNNING" };
		}
		return view(s);
	};
	const fetch = async (input, init) => {
		const call = await rec.read(input, init);
		if (call.headers["X-BB-API-Key"] !== BROWSERBASE_KEY) return json(401, { error: `Unauthorized ${ECHO}` });
		const [, , , id, sub] = call.path.split("/");
		if (call.method === "POST" && call.path === "/v1/sessions") {
			if (knobs.failCreate) return json(knobs.failCreate, { error: `no ${ECHO}` });
			// Browserbase refuses a userMetadata key with a dot, as it answered live on 11-08.
			const dotted = Object.keys(call.body?.userMetadata ?? {}).find((key) => key.includes("."));
			if (dotted !== undefined) return json(400, { error: "Bad Request", message: `Key is not a valid metadata key: ${dotted}`, statusCode: 400 });
			const sid = `sess_${++seq}`;
			const now = Date.parse("2026-11-08T12:00:00.000Z") + seq * 1000;
			const s = {
				id: sid,
				status: "RUNNING",
				createdAt: new Date(now).toISOString(),
				expiresAt: new Date(now + call.body.timeout * 1000).toISOString(),
				keepAlive: call.body.keepAlive === true,
				userMetadata: { ...call.body.userMetadata },
				// Browserbase's own shape, wss: on browserbase.com (read live 11-08); knobs.connectUrl(sid) answers another, or none.
				connectUrl: knobs.connectUrl ? knobs.connectUrl(sid) : `wss://connect.browserbase.com/${sid}?signingKey=SECRET-${sid}`,
				lag: 0,
			};
			sessions.set(sid, s);
			known.add(s.connectUrl, () => s.status === "RUNNING");
			return json(201, view(s));
		}
		if (call.method === "GET" && call.path === "/v1/sessions") {
			const q = /^user_metadata\['([^']+)'\]:'([^']*)'$/.exec(call.query.q ?? "");
			const rows = [...sessions.values()]
				.filter((s) => call.query.status === undefined || s.status === call.query.status)
				.filter((s) => q === null || s.userMetadata[q[1]] === q[2]);
			return json(200, rows.map(view));
		}
		const s = sessions.get(id);
		if (s === undefined) return json(404, { error: `Session not found ${ECHO}` });
		if (call.method === "GET" && sub === undefined) return json(200, lagging(s));
		if (call.method === "GET" && sub === "debug") {
			if (s.status !== "RUNNING") return json(400, { error: `Session is not running ${ECHO}` });
			const live = `https://www.browserbase.test/devtools-fullscreen/inspector.html?s=${s.id}&token=SECRET-live-${s.id}`;
			return json(200, { debuggerFullscreenUrl: live, debuggerUrl: live.replace("-fullscreen", ""), wsUrl: s.connectUrl, pages: [{ id: "p1", url: "about:blank", title: "", debuggerFullscreenUrl: live }] });
		}
		if (call.method === "POST" && sub === undefined) {
			if (call.body?.status !== "REQUEST_RELEASE") return json(400, { error: "status must be REQUEST_RELEASE" });
			if (s.status === "RUNNING") {
				s.status = "COMPLETED";
				s.lag = knobs.releaseLag ?? 0;
			}
			return json(200, view(s));
		}
		return json(404, { error: "no such route" });
	};
	return { fetch, cdp: cdp.dial, dialed: cdp.dialed, sessions, calls: rec.calls, only: rec.only };
}

/** A fake Kernel. knobs: failCreate (a status the create answers, with ECHO in its body), pageSize (rows per list page). */
export function fakeKernel(knobs = {}) {
	const rec = recorder(KERNEL_URL);
	const known = browsers();
	const cdp = cdpDialer(known, knobs);
	const browsersById = new Map();
	let seq = 0;
	const view = (b) => ({
		session_id: b.id,
		cdp_ws_url: b.cdp,
		browser_live_view_url: b.live,
		created_at: b.createdAt,
		timeout_seconds: b.timeout,
		headless: false,
		stealth: false,
		tags: { ...b.tags },
		...(b.deletedAt ? { deleted_at: b.deletedAt } : {}),
	});
	const fetch = async (input, init) => {
		const call = await rec.read(input, init);
		if (call.headers.Authorization !== `Bearer ${KERNEL_KEY}`) return json(401, { code: "unauthorized", message: `bad key ${ECHO}` });
		const [, , id] = call.path.split("/");
		if (call.method === "POST" && call.path === "/browsers") {
			if (knobs.failCreate) return json(knobs.failCreate, { code: "internal_error", message: `no ${ECHO}` });
			const bid = `kb_${++seq}`;
			const b = {
				id: bid,
				// Kernel's own shape, wss: on kernel.sh, port 8443 (read live 11-08); knobs.cdpUrl(bid) answers another, or none.
				cdp: knobs.cdpUrl ? knobs.cdpUrl(bid) : `wss://cdp.kernel.sh:8443/${bid}?jwt=SECRET-${bid}`,
				live: `https://live.kernel.test/${bid}?jwt=SECRET-live-${bid}`,
				createdAt: new Date(Date.parse("2026-11-08T12:00:00.000Z") + seq * 1000).toISOString(),
				timeout: call.body.timeout_seconds,
				tags: { ...call.body.tags },
				deletedAt: undefined,
			};
			browsersById.set(bid, b);
			known.add(b.cdp, () => b.deletedAt === undefined);
			return json(200, view(b));
		}
		if (call.method === "GET" && call.path === "/browsers") {
			const filters = Object.entries(call.query)
				.map(([key, value]) => [/^tags\[(.+)\]$/.exec(key)?.[1], value])
				.filter(([key]) => key !== undefined);
			const rows = [...browsersById.values()]
				.filter((b) => call.query.status !== "active" || b.deletedAt === undefined)
				.filter((b) => filters.every(([key, value]) => b.tags[key] === value));
			const offset = Number(call.query.offset ?? 0);
			const size = knobs.pageSize ?? Number(call.query.limit ?? 100);
			const page = rows.slice(offset, offset + size);
			const more = offset + size < rows.length;
			return json(200, page.map(view), more ? { "x-has-more": "true", "x-next-offset": String(offset + size) } : { "x-has-more": "false" });
		}
		const b = browsersById.get(id);
		if (b === undefined || b.deletedAt !== undefined) return json(404, { code: "not_found", message: `no browser ${ECHO}` });
		if (call.method === "GET") return json(200, view(b));
		if (call.method === "DELETE") {
			b.deletedAt = "2026-11-08T12:30:00.000Z";
			return new Response(null, { status: 204 });
		}
		return json(404, { code: "not_found" });
	};
	return { fetch, cdp: cdp.dial, dialed: cdp.dialed, browsers: browsersById, calls: rec.calls, only: rec.only };
}
