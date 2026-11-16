// AgentRun's relay for Cloudflare Containers, deployed once to the operator's own account from this folder:
// `npx wrangler secret put RELAY_TOKEN`, then `npx wrangler deploy` (Docker must run: Wrangler builds the Dockerfile and
// pushes it to the account's registry). wrangler.json names the box image twice, BOX_IMAGE for the build and for this
// relay's answers: keep the two the same, the tag the AgentRun server's release publishes; a new box image is a redeploy.
// Its observability is off, since requests carry each machine's attach token.
//
// Cloudflare has no REST call that starts a container: a Durable Object starts one, so this Worker is the
// REST API the provider (packages/computer/src/cloudflare.ts) calls. It creates, reads, lists and deletes computers and
// nothing more: no exec, no upload. Each computer's computerd dials the AgentRun server itself (agentrun-dial, from
// the boot env), so nothing reaches into a container through here.
//
// One Computer object per computer, by name (the name is the create's idempotency key), holds its row and its container;
// one Index object holds every row's labels, since Durable Object namespaces can't be listed. The relay never logs a
// request body: a create's carries the machine's attach token. Every route takes `Authorization: Bearer <RELAY_TOKEN>`,
// and a relay with no RELAY_TOKEN refuses every call.
//
// Pages: A = developers.cloudflare.com/containers/api/durable-object-container/ (start, monitor, destroy,
// setInactivityTimeout, images), L = /sandbox/concepts/lifetime/ (an instance stops once its object is inactive; code in
// the container doesn't count as activity; an alarm does).

/** The relay's routes and rows, as the provider speaks them: a change to either is a new version (descriptors/cloudflare.ts). */
export const RELAY_VERSION = 1;
const NAME = /^computer-[0-9a-f]{12}$/;
/** A: start()'s named instance types; the provider picks one by size. */
const INSTANCES = new Set(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]);
const HOUR_MS = 3_600_000;
/** A: setInactivityTimeout's most, 6 h. The alarm sets it again every hour, so a quiet container is kept (L). */
const IDLE_MS = 6 * HOUR_MS;
/** The box image's program that fetches computerd from the server, starts init and dials (box/install.sh). */
const DIAL = "/usr/local/bin/agentrun-dial";

interface Stub {
	fetch(request: Request): Promise<Response>;
}
interface Env {
	COMPUTER: { getByName(name: string): Stub };
	INDEX: { getByName(name: string): Stub };
	RELAY_TOKEN?: string;
	/** The box image this relay's Dockerfile is FROM (wrangler.json's vars), which every computer starts from. */
	BOX_IMAGE: string;
}
interface Storage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	deleteAll(): Promise<void>;
	list<T>(): Promise<Map<string, T>>;
	setAlarm(at: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}
interface Container {
	readonly running: boolean;
	readonly images: Record<string, string>;
	start(options: { image: string; env: Record<string, string>; entrypoint: string[]; enableInternet: boolean; instance: string }): void;
	monitor(): Promise<void>;
	destroy(reason?: string): Promise<void>;
	setInactivityTimeout(ms: number): Promise<void>;
}
interface State {
	storage: Storage;
	container: Container;
	blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}
/** A computer as the relay keeps it: ended is why it stopped, once it has. */
interface Row {
	name: string;
	labels: Record<string, string>;
	createdAt: string;
	backstopAt: string;
	ended?: string;
}

const answer = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string) => answer(status, { error });
const strings = (value: unknown): value is Record<string, string> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((one) => typeof one === "string");

/** Whether two strings are equal, compared by their SHA-256 in full, so the time taken says nothing of the token. */
async function same(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([a, b].map(async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
	let differ = 0;
	for (let at = 0; at < x.length; at++) differ |= x[at] ^ y[at];
	return differ === 0;
}

/** What a create's body must be: its problem in words, or none. */
function createProblem(body: Record<string, unknown>, env: Env): string | undefined {
	if (typeof body.name !== "string" || !NAME.test(body.name)) return "name must be computer-<12 hex digits>";
	if (body.image !== env.BOX_IMAGE) return `this relay starts ${env.BOX_IMAGE} alone, not ${JSON.stringify(body.image)}: ask for it, or redeploy the relay FROM the image you want`;
	if (!strings(body.env) || !strings(body.labels)) return "env and labels must map names to strings";
	if (typeof body.instance !== "string" || !INSTANCES.has(body.instance)) return `instance must be one of ${[...INSTANCES].join(", ")}`;
	if (Number.isNaN(Date.parse(String(body.backstopAt)))) return "backstopAt must be an ISO time";
	return undefined;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.RELAY_TOKEN) return refuse(503, "this relay has no RELAY_TOKEN: set one with `npx wrangler secret put RELAY_TOKEN`, then use the same token in AgentRun");
		if (!(await same(request.headers.get("authorization") ?? "", `Bearer ${env.RELAY_TOKEN}`))) return refuse(401, "the bearer token is not this relay's RELAY_TOKEN");
		const url = new URL(request.url);
		const { method } = request;
		if (url.pathname === "/v1/health" && method === "GET") return answer(200, { version: RELAY_VERSION, image: env.BOX_IMAGE });
		if (url.pathname === "/v1/computers" && method === "GET") return env.INDEX.getByName("index").fetch(new Request(`https://index/${url.search}`));
		if (url.pathname === "/v1/computers" && method === "POST") {
			const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
			const problem = body === null ? "the body must be JSON" : createProblem(body, env);
			if (problem || body === null) return refuse(422, problem ?? "");
			return env.COMPUTER.getByName(body.name as string).fetch(new Request(`https://computer/${body.name}`, { method, body: JSON.stringify(body) }));
		}
		const name = /^\/v1\/computers\/([^/]+)$/.exec(url.pathname)?.[1];
		if (name !== undefined && (method === "GET" || method === "DELETE")) {
			if (!NAME.test(name)) return refuse(404, `${name} is no computer of this relay`);
			return env.COMPUTER.getByName(name).fetch(new Request(`https://computer/${name}`, { method }));
		}
		return refuse(404, `${method} ${url.pathname} is no route of this relay`);
	},
};

/** One computer: its row, its container, and its alarm, the keepalive and the backstop. */
export class Computer {
	readonly #state: State;
	readonly #env: Env;
	/** Set once this object ends its container (until a new start), so the monitor's settling never writes the row back. */
	#ended = false;

	constructor(state: State, env: Env) {
		this.#state = state;
		this.#env = env;
		// A: monitor() does not survive a restart of the object: watch again a container whose row is open.
		void state.blockConcurrencyWhile(async () => {
			const row = await state.storage.get<Row>("row");
			if (row !== undefined && row.ended === undefined) this.#watch();
		});
	}

	async fetch(request: Request): Promise<Response> {
		const name = new URL(request.url).pathname.slice(1);
		const row = await this.#state.storage.get<Row>("row");
		if (request.method === "GET") return row === undefined ? refuse(404, "no such computer") : answer(200, this.#view(row));
		if (request.method === "DELETE") {
			if (row !== undefined) await this.#end(name);
			else {
				// Nothing kept: a container a failed delete left, or an index entry whose delete threw, ends here.
				if (this.#state.container.running) await this.#state.container.destroy("deleted");
				await this.#index("DELETE", { name });
			}
			return answer(204);
		}
		const body = (await request.json()) as Row & { env: Record<string, string>; instance: string };
		// One create at a time: a second of the same name waits for the first, then answers its row, whatever its state.
		return this.#state.blockConcurrencyWhile(async () => {
			const first = await this.#state.storage.get<Row>("row");
			if (first !== undefined) return answer(200, this.#view(first));
			const made: Row = { name, labels: body.labels, createdAt: new Date().toISOString(), backstopAt: body.backstopAt };
			// The index first, so the provider's sweep by name finds whatever follows; a start that throws takes it back.
			await this.#index("PUT", made);
			const container = this.#state.container;
			try {
				container.start({ image: container.images.box, env: body.env, entrypoint: [DIAL], enableInternet: true, instance: body.instance });
			} catch (error) {
				// A: start() throws while a container runs; with no row, one a failed delete left. It ends before its entry
				// goes, so nothing runs unlisted: a destroy that throws keeps the entry, and the sweep's DELETE ends it.
				if (container.running) await container.destroy("stray");
				await this.#index("DELETE", made);
				return refuse(500, `Cloudflare did not start the container: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.#ended = false;
			await this.#state.storage.put("row", made);
			await container.setInactivityTimeout(IDLE_MS);
			await this.#nextAlarm(made);
			this.#watch();
			return answer(201, this.#view(made));
		});
	}

	/** Every hour: the inactivity timeout again, so a quiet container stays (L); at backstopAt, the end. */
	async alarm(): Promise<void> {
		const row = await this.#state.storage.get<Row>("row");
		if (row === undefined) return;
		if (Date.now() >= Date.parse(row.backstopAt)) return this.#end(row.name);
		if (row.ended === undefined && this.#state.container.running) await this.#state.container.setInactivityTimeout(IDLE_MS);
		await this.#nextAlarm(row);
	}

	#view(row: Row) {
		const state = row.ended !== undefined ? "gone" : this.#state.container.running ? "running" : "starting";
		return { name: row.name, labels: row.labels, image: this.#env.BOX_IMAGE, createdAt: row.createdAt, state, ...(row.ended === undefined ? {} : { why: row.ended }) };
	}

	#nextAlarm(row: Row): Promise<void> {
		return this.#state.storage.setAlarm(Math.min(Date.now() + HOUR_MS, Date.parse(row.backstopAt)));
	}

	/** The index entry written or dropped; a call that fails throws, so the route answers 500 and the caller asks again. */
	async #index(method: "PUT" | "DELETE", row: Pick<Row, "name"> & Partial<Row>): Promise<void> {
		const done = await this.#env.INDEX.getByName("index").fetch(new Request(`https://index/${row.name}`, { method, ...(method === "PUT" ? { body: JSON.stringify(row) } : {}) }));
		if (!done.ok) throw new Error(`the index answered ${done.status} to ${method} ${row.name}`);
	}

	/** The container watched until it stops (A, monitor): the row then reads gone, with why. */
	#watch(): void {
		let stopped: Promise<void>;
		try {
			stopped = this.#state.container.monitor();
		} catch {
			stopped = Promise.reject(new Error("its container is gone"));
		}
		stopped
			.then(
				() => this.#stopped("its main process exited"),
				(error: unknown) => this.#stopped(`it stopped: ${error instanceof Error ? error.message : String(error)}`),
			)
			// Its row reads gone already; an index entry that missed it reads running until the computer's delete drops it.
			.catch(() => undefined);
	}

	async #stopped(why: string): Promise<void> {
		const row = await this.#state.storage.get<Row>("row");
		if (this.#ended || row === undefined || row.ended !== undefined) return;
		const ended = { ...row, ended: why };
		await this.#state.storage.put("row", ended);
		await this.#index("PUT", ended);
	}

	/**
	 * Delete and backstop: the container destroyed, then the row, its alarm and its index entry gone. An index call that
	 * throws leaves the entry alone, and the next DELETE, finding no row, drops it.
	 */
	async #end(name: string): Promise<void> {
		this.#ended = true;
		if (this.#state.container.running) await this.#state.container.destroy("deleted");
		await this.#state.storage.deleteAlarm();
		await this.#state.storage.deleteAll();
		await this.#index("DELETE", { name });
	}
}

/** Every computer's labels, by name, for the listing: GET /?k=v answers the rows with every label asked for. */
export class Index {
	readonly #storage: Storage;

	constructor(state: State) {
		this.#storage = state.storage;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const name = url.pathname.slice(1);
		if (request.method === "PUT") await this.#storage.put(name, await request.json());
		else if (request.method === "DELETE") await this.#storage.delete(name);
		else {
			const asked = [...url.searchParams];
			const rows = [...(await this.#storage.list<Row>()).values()].filter((row) => asked.every(([key, value]) => row.labels[key] === value));
			return answer(200, { computers: rows.map(({ name, labels, createdAt, ended }) => ({ name, labels, createdAt, state: ended === undefined ? "running" : "gone" })) });
		}
		return answer(204);
	}
}
