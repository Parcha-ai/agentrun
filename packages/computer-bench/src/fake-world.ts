// A fake computer for tests and dry runs, $0: a small world of two apps (Settings and Notes), settings, notes and files,
// answering the protocol's methods in process the way a driver of protocol 0.2 does (hello, ui.observe, ui.act with
// routes, verified, changed and state ids, exec.run, files, apps, screen). Tasks run on it pass or fail deterministically,
// so the runner, the checks, the grader's plumbing and the report are tested with no Mac, no phone and no model.
// exec.run understands a few words instead of a shell: get/set a setting, list/read/delete notes, cat/write/rm a file.
// Faults can be set: the connection gone after N calls, methods denied, a slow answer.
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { AgentRequest, AgentResult, Backend, Episode, OpenRequest } from "./runner.js";
import type { AgentWire } from "./tap.js";
import type { Hello, JsonObject, Wire, WireResult } from "./wire.js";

export interface FakeNode {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	bounds: [number, number, number, number];
	flags?: string[];
	actions?: string[];
}

interface Element {
	/** What the element is, stable while it exists: its ref is made from this. */
	key: string;
	role: string;
	name?: string;
	value?: string;
	flags?: string[];
	press?: () => void;
	set?: (value: string) => void;
}

interface AppView {
	id: string;
	name: string;
	title: string;
	elements: Element[];
}

export interface FakeWorldOptions {
	os?: string;
	kind?: string;
	osVersion?: string;
	groups?: string[];
	/** Bytes per screen.shot chunk (default: all at once), to walk screen.read. */
	chunk?: number;
	faults?: {
		/** After this many calls, every call answers `gone`. */
		goneAfter?: number;
		/** These methods answer `denied`. */
		deny?: string[];
		/** Each call waits this long. */
		slowMs?: number;
	};
}

const ok = (value: unknown): WireResult => ({ ok: true, value });
const err = (code: string, message: string): WireResult => ({ ok: false, error: { code, message } });
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
/** The protocol's most bytes for one files.read (MAX_CHUNK_BYTES). */
const READ_CHUNK = 512 * 1024;

/** A small PNG of one colour, made from a seed: the same world state gives the same bytes. */
export function pngOf(seed: string, size = 8): Buffer {
	const [r, g, b] = createHash("sha256").update(seed).digest();
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from([r as number, g as number, b as number]))]);
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(data: Buffer): number {
	let crc = ~0;
	for (const byte of data) {
		crc ^= byte;
		for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc;
}

export const SETTINGS_APP = "fake.settings";
export const NOTES_APP = "fake.notes";
/** The protocol's ui fixture app (its fake ui driver runs it): the fixture suite's tasks and plays are written for it. */
export const FIXTURE_APP = "ai.agentrun.uifixture";

export class FakeWorld implements Wire {
	readonly settings = new Map<string, string>([
		["dark", "no"],
		["device_name", "Fake Phone"],
		["volume", "5"],
	]);
	readonly notes: { title: string; body: string }[] = [];
	readonly files = new Map<string, string>();
	readonly running = new Set<string>();
	front: string | null = null;
	/** Every method called, in order, for tests to read. */
	readonly calls: string[] = [];
	released = false;
	#state = 1;
	#lastSeen = "";
	#draft: { title: string; body: string } | undefined;
	#shots = new Map<string, Buffer>();
	readonly #refs = new Map<string, string>();

	constructor(readonly options: FakeWorldOptions = {}) {}

	hello(): Hello {
		return {
			protocol: "0.2",
			version: "fake-0.2.0",
			os: this.options.os ?? "macos",
			osVersion: this.options.osVersion ?? "fake",
			kind: this.options.kind ?? "desktop",
			arch: "arm64",
			groups: this.options.groups ?? ["exec", "files", "screen", "input.pointer", "input.keys", "apps", "ui"],
			screen: { width: 1440, height: 900, scale: 2 },
			device: { maker: "Fake", model: "Fake World" },
		};
	}

	/** What the screen shows, in words: its image is made from this. */
	#scene(): string {
		return JSON.stringify({ front: this.front, view: this.front ? this.#view(this.front)?.elements.map((e) => [e.key, e.value]) : null });
	}

	/** The state id: a new one whenever the scene changed since it was last read. */
	#stateId(): string {
		const scene = this.#scene();
		if (scene !== this.#lastSeen) {
			if (this.#lastSeen !== "") this.#state += 1;
			this.#lastSeen = scene;
		}
		return `s${this.#state}`;
	}

	#refOf(key: string): string {
		let ref = this.#refs.get(key);
		if (!ref) {
			ref = `@e${this.#refs.size + 1}`;
			this.#refs.set(key, ref);
		}
		return ref;
	}

	#view(app: string): AppView | undefined {
		if (app === SETTINGS_APP) {
			return {
				id: SETTINGS_APP,
				name: "Settings",
				title: "Settings",
				elements: [
					{ key: "settings.dark", role: "switch", name: "Dark theme", value: this.settings.get("dark") === "yes" ? "on" : "off", press: () => this.settings.set("dark", this.settings.get("dark") === "yes" ? "no" : "yes") },
					{ key: "settings.device_name", role: "textbox", name: "Device name", value: this.settings.get("device_name"), set: (value) => this.settings.set("device_name", value) },
					{ key: "settings.volume", role: "slider", name: "Volume", value: this.settings.get("volume"), set: (value) => this.settings.set("volume", value) },
				],
			};
		}
		if (app === NOTES_APP) {
			const draft = this.#draft;
			const list: Element[] = this.notes.map((note, i) => ({ key: `notes.row.${note.title}.${i}`, role: "row", name: note.title, value: note.body }));
			if (draft) {
				return {
					id: NOTES_APP,
					name: "Notes",
					title: "New note",
					elements: [
						...list,
						{ key: "notes.draft.title", role: "textbox", name: "Title", value: draft.title, set: (value) => void (draft.title = value) },
						{ key: "notes.draft.body", role: "textbox", name: "Body", value: draft.body, set: (value) => void (draft.body = value) },
						{ key: "notes.save", role: "button", name: "Save", press: () => {
							this.notes.push({ ...draft });
							this.#draft = undefined;
						} },
					],
				};
			}
			return { id: NOTES_APP, name: "Notes", title: "Notes", elements: [...list, { key: "notes.new", role: "button", name: "New Note", press: () => void (this.#draft = { title: "", body: "" }) }] };
		}
		return undefined;
	}

	#nodes(view: AppView): FakeNode[] {
		return view.elements.map((element, i) => ({
			ref: this.#refOf(element.key),
			role: element.role,
			...(element.name === undefined ? {} : { name: element.name }),
			...(element.value === undefined ? {} : { value: element.value }),
			bounds: [20, 40 + 44 * i, 400, 40] as [number, number, number, number],
			...(element.flags ? { flags: element.flags } : {}),
			actions: [...(element.press ? ["press"] : []), ...(element.set ? ["set"] : [])],
		}));
	}

	#find(app: string, ref: string): Element | undefined {
		const view = this.#view(app);
		return view?.elements.find((element) => this.#refs.get(element.key) === ref);
	}

	#exec(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
		const [word, ...rest] = argv;
		const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: "" });
		const bad = (stderr: string, exitCode = 1) => ({ exitCode, stdout: "", stderr });
		switch (word) {
			case "true":
				return out("");
			case "false":
				return bad("");
			case "echo":
				return out(`${rest.join(" ")}\n`);
			case "get": {
				const value = this.settings.get(rest[0] ?? "");
				return value === undefined ? bad(`no setting ${rest[0]}`) : out(`${value}\n`);
			}
			case "set":
				this.settings.set(rest[0] ?? "", rest[1] ?? "");
				return out("");
			case "notes":
				return out(this.notes.map((note) => `${note.title}\n`).join(""));
			case "note": {
				const note = this.notes.find((one) => one.title === rest[0]);
				return note ? out(`${note.body}\n`) : bad(`no note ${rest[0]}`);
			}
			case "count-notes":
				return out(`${this.notes.filter((one) => one.title === rest[0]).length}\n`);
			case "make-note":
				this.notes.push({ title: rest[0] ?? "", body: rest[1] ?? "" });
				return out("");
			case "delete-note": {
				for (let i = this.notes.length - 1; i >= 0; i -= 1) if (this.notes[i]?.title === rest[0]) this.notes.splice(i, 1);
				return out("");
			}
			case "cat": {
				const text = this.files.get(rest[0] ?? "");
				return text === undefined ? bad(`cat: ${rest[0]}: No such file`) : out(text);
			}
			case "write":
				this.files.set(rest[0] ?? "", rest[1] ?? "");
				return out("");
			case "rm":
				this.files.delete(rest[0] ?? "");
				return out("");
			default:
				return bad(`${word}: not found`, 127);
		}
	}

	async call(method: string, params: JsonObject = {}): Promise<WireResult> {
		this.calls.push(method);
		const faults = this.options.faults ?? {};
		if (faults.slowMs) await new Promise((resolve) => setTimeout(resolve, faults.slowMs));
		if (this.released) return err("gone", "the computer was released");
		if (faults.goneAfter !== undefined && this.calls.length > faults.goneAfter) return err("gone", "the daemon's stream ended");
		if (faults.deny?.includes(method)) return err("denied", `${method} is denied here`);
		const hello = this.hello();
		const group = method.split(".")[0] === "tar" ? "files" : method === "exec.run" ? "exec" : method.startsWith("process.") ? "processes" : method.split(".")[0];
		if (method !== "hello" && method !== "ping" && !(group === "input" ? hello.groups.some((g) => g.startsWith("input.")) : hello.groups.includes(group as string))) return err("unsupported", `this computer has no ${method}`);
		switch (method) {
			case "hello":
				return ok(hello);
			case "ping":
				return ok({});
			case "exec.run": {
				const argv = (params.argv as string[]) ?? [];
				const ran = this.#exec(argv);
				return ok({ exitCode: ran.exitCode, stdout: b64(ran.stdout), stderr: b64(ran.stderr), timedOut: false, truncated: false });
			}
			case "files.read": {
				const text = this.files.get(String(params.path));
				if (text === undefined) return err("not_found", `no such file: ${params.path}`);
				// In chunks of at most the protocol's 512 KiB, by offset, as a real computer reads.
				const bytes = Buffer.from(text, "utf8");
				const offset = Number(params.offset ?? 0);
				const end = Math.min(bytes.length, offset + Math.min(Number(params.length ?? READ_CHUNK), READ_CHUNK));
				return ok({ data: bytes.subarray(offset, end).toString("base64"), eof: end >= bytes.length, size: bytes.length });
			}
			case "files.write":
				this.files.set(String(params.path), Buffer.from(String(params.data), "base64").toString("utf8"));
				return ok({});
			case "apps.list":
				return ok({ apps: [{ id: SETTINGS_APP, name: "Settings" }, { id: NOTES_APP, name: "Notes" }], foreground: this.front });
			case "apps.launch": {
				const id = String(params.id);
				if (!this.#view(id)) return err("not_found", `no app ${id}`);
				this.running.add(id);
				this.front = id;
				return ok({});
			}
			case "apps.terminate": {
				this.running.delete(String(params.id));
				if (this.front === params.id) this.front = null;
				if (params.id === NOTES_APP) this.#draft = undefined;
				return ok({});
			}
			case "screen.shot": {
				const png = pngOf(this.#scene());
				const size = this.options.chunk ?? png.length;
				const id = `shot${this.calls.length}`;
				this.#shots.set(id, png);
				return ok({ id, size: png.length, data: png.subarray(0, size).toString("base64"), eof: size >= png.length, width: 1440, height: 900, scale: 2 });
			}
			case "screen.read": {
				const png = this.#shots.get(String(params.id));
				if (!png) return err("not_found", `no shot ${params.id}`);
				const offset = Number(params.offset);
				const size = this.options.chunk ?? png.length;
				return ok({ data: png.subarray(offset, offset + size).toString("base64"), eof: offset + size >= png.length });
			}
			case "ui.observe": {
				const app = (params.target as { app?: string } | undefined)?.app ?? this.front;
				if (!app || !this.running.has(app)) return err("not_found", `${app ?? "no app"} is not running`);
				const view = this.#view(app) as AppView;
				return ok({
					state: this.#stateId(),
					app: { id: view.id, name: view.name },
					window: { id: `${view.id}.main`, title: view.title, bounds: [0, 0, 1440, 900] },
					nodes: this.#nodes(view),
					truncated: false,
					...(params.image ? { image: { format: "png", width: 8, height: 8, data: pngOf(this.#scene()).toString("base64") } } : {}),
				});
			}
			case "ui.act":
				return this.#act(params);
			default:
				return err("unsupported", `the fake world has no ${method}`);
		}
	}

	#act(params: JsonObject): WireResult {
		const app = (params.target as { app?: string } | undefined)?.app ?? this.front;
		if (!app || !this.running.has(app)) return err("not_found", app ? `${app} is not running` : "no app is in front");
		const before = this.#scene();
		const current = this.#stateId();
		const results: unknown[] = [];
		const steps = (params.steps as JsonObject[]) ?? [];
		for (const step of steps) {
			// A refused step is the last: the steps after it do not run, and are not listed.
			if (results.some((one) => (one as { error?: unknown }).error)) break;
			const refOrPoint = (step.press ?? step.set ?? step.click ?? step.into) as string | number[] | undefined;
			if (Array.isArray(refOrPoint) && params.state !== current) {
				results.push({ error: { kind: "stale", message: `the screen moved since ${String(params.state)}: the point is not where it was` } });
				continue;
			}
			const element = typeof refOrPoint === "string" ? this.#find(app, refOrPoint) : undefined;
			if (typeof refOrPoint === "string" && !element) {
				results.push({ error: { kind: "stale", message: `${refOrPoint} is gone` } });
				continue;
			}
			if ("press" in step || "click" in step) {
				if (!element?.press) {
					results.push({ error: { kind: "unsupported", message: `${String(refOrPoint)} can't be pressed` } });
					continue;
				}
				element.press();
			} else if ("set" in step) {
				if (!element?.set) {
					results.push({ error: { kind: "unsupported", message: `${String(refOrPoint)} can't be set` } });
					continue;
				}
				element.set(String(step.value));
			} else if ("type" in step) {
				const target = element ?? this.#view(app)?.elements.find((one) => one.set);
				if (!target?.set) {
					results.push({ error: { kind: "unsupported", message: "nothing here takes text" } });
					continue;
				}
				target.set(`${target.value ?? ""}${String(step.type)}`);
			} else if (!("wait" in step) && !("key" in step)) {
				results.push({ error: { kind: "invalid", message: `a step the fake world doesn't know: ${JSON.stringify(step)}` } });
				continue;
			}
			results.push({ route: "semantic", verified: true });
		}
		const changed = this.#scene() !== before;
		const expect = params.expect as { text?: string; gone?: boolean } | undefined;
		let met: "met" | "unmet" | undefined;
		if (expect?.text !== undefined) {
			const view = this.#view(app);
			const seen = (view?.elements ?? []).some((one) => `${one.name ?? ""} ${one.value ?? ""}`.includes(String(expect.text)));
			met = seen !== Boolean(expect.gone) ? "met" : "unmet";
		}
		return ok({ steps: results, state: this.#stateId(), changed, ...(met ? { expect: met } : {}) });
	}
}

/** An agent for the fake world: given its tapped wire (its surface: on "code" its calls go through wire.script) and the
 *  request, it does whatever it does. */
export type FakeAgent = (wire: AgentWire, request: AgentRequest) => Promise<AgentResult>;

export interface FakeBackendOptions {
	/** Makes each episode's world (default: a fresh FakeWorld). */
	world?: (request: OpenRequest) => FakeWorld;
	/** Each episode's computer from elsewhere instead of a FakeWorld: another fake driver's connection (a protocol client
	 *  is a Wire), closed on release. */
	connect?: (request: OpenRequest) => Promise<{ wire: Wire; close(): Promise<void> }>;
	/** Agents by harness name. */
	agents: Record<string, FakeAgent>;
	/** The groups the agent is given (default: all the world offers). */
	agentGroups?: string[];
	/** Refuse the first N opens as infra (a vendor that had no computer). */
	failOpens?: number;
	/** Every world made, in order. */
	worlds?: FakeWorld[];
}

/** A backend over fake worlds: each episode gets a fresh world, and the arm's harness names its agent. */
export function fakeBackend(options: FakeBackendOptions): Backend {
	let opens = 0;
	return {
		id: "fake",
		async open(request) {
			opens += 1;
			if (options.failOpens !== undefined && opens <= options.failOpens) return { ok: false, error: { code: "vendor", message: "the fake vendor had no computer free" } };
			const agent = options.agents[request.arm.harness];
			const connected = options.connect ? await options.connect(request) : undefined;
			const world = connected ? undefined : (options.world?.(request) ?? new FakeWorld());
			if (world) options.worlds?.push(world);
			const wire: Wire = connected?.wire ?? (world as FakeWorld);
			const episode: Episode = {
				identity: { provider: connected ? "fake-connected" : "fake", ref: `fake-${opens}` },
				bench: wire,
				...(options.agentGroups ? { agentGroups: options.agentGroups } : {}),
				agent: async (agentRequest) => (agent ? agent(agentRequest.tap(wire), agentRequest) : { outcome: "refused", message: `no fake agent for harness ${request.arm.harness}` }),
				async release() {
					if (world) world.released = true;
					await connected?.close();
				},
			};
			return { ok: true, value: episode };
		},
	};
}

/** How a fake agent does a fake suite task, right or wrong. */
type Play = (h: ReturnType<typeof helper>, wire: Wire, request: AgentRequest) => Promise<string | undefined>;

const RIGHT: Record<string, Play> = {
	"fake.settings.dark-theme": async (h) => {
		await h.observe(SETTINGS_APP);
		await h.act([{ press: h.find("Dark theme") as string }]);
		return undefined;
	},
	"fake.notes.new-note": async (h, _wire, request) => {
		await h.observe(NOTES_APP);
		await h.act([{ press: h.find("New Note") as string }]);
		await h.observe(NOTES_APP);
		const params = request.task.params as { title: string; body: string };
		await h.act([
			{ set: h.find("Title") as string, value: `${params.title} ${request.task.nonce}` },
			{ set: h.find("Body") as string, value: params.body },
			{ press: h.find("Save") as string },
		]);
		return undefined;
	},
	"fake.settings.device-name": async (h) => {
		const seen = await h.observe(SETTINGS_APP);
		return seen.nodes.find((node) => node.name === "Device name")?.value;
	},
	"fake.files.write": async (_h, wire, request) => {
		await wire.call("files.write", { path: `/tmp/bench-${request.task.nonce}.txt`, data: b64(String(request.task.params.n)) });
		return undefined;
	},
	"fake.settings.volume-judged": async (h) => {
		await h.observe(SETTINGS_APP);
		await h.act([{ set: h.find("Volume") as string, value: "6" }]);
		return undefined;
	},
	"fake.notes.front": async (h) => {
		await h.launch(NOTES_APP);
		return undefined;
	},
	"fixture.save": async (h, _wire, request) => {
		await h.observe(FIXTURE_APP);
		await h.act([{ set: h.find("Name") as string, value: String(request.task.params.name) }, { press: h.find("Save") as string }], { app: FIXTURE_APP, expect: { text: "Saved" } });
		return undefined;
	},
	"fixture.wifi": async (h) => {
		await h.observe(FIXTURE_APP);
		await h.act([{ press: h.find("Wi-Fi") as string }], { app: FIXTURE_APP });
		return undefined;
	},
	"fixture.second-page": async (h) => {
		await h.observe(FIXTURE_APP);
		await h.act([{ press: h.find("Next") as string }], { app: FIXTURE_APP, expect: { text: "Second page" } });
		return undefined;
	},
	"fixture.canvas": async (h) => {
		await h.observe(FIXTURE_APP);
		const canvas = h.find("Canvas") as string;
		await h.act([{ click: canvas }, { click: canvas }, { click: canvas }], { app: FIXTURE_APP, foreground: true });
		return undefined;
	},
};

const WRONG: Record<string, Play> = {
	"fake.settings.dark-theme": async (h) => {
		await h.observe(SETTINGS_APP);
		await h.act([{ set: h.find("Device name") as string, value: "Dark" }]);
		return undefined;
	},
	"fake.notes.new-note": async (h, _wire, request) => {
		await h.observe(NOTES_APP);
		await h.act([{ press: h.find("New Note") as string }]);
		await h.observe(NOTES_APP);
		await h.act([{ set: h.find("Title") as string, value: `${String(request.task.params.title)} ${request.task.nonce}` }, { set: h.find("Body") as string, value: "something else" }, { press: h.find("Save") as string }]);
		return undefined;
	},
	"fake.settings.device-name": async () => "Fake Phone",
	"fake.files.write": async (_h, wire, request) => {
		await wire.call("files.write", { path: `/tmp/bench-${request.task.nonce}.txt`, data: b64(String(Number(request.task.params.n) + 1)) });
		return undefined;
	},
	"fake.settings.volume-judged": async (h) => {
		await h.observe(SETTINGS_APP);
		await h.act([{ set: h.find("Volume") as string, value: "1" }]);
		return undefined;
	},
	"fake.notes.front": async (h) => {
		await h.launch(SETTINGS_APP);
		return undefined;
	},
	// Saves before the name is in, and stops without waiting for Saved.
	"fixture.save": async (h, _wire, request) => {
		await h.observe(FIXTURE_APP);
		await h.act([{ press: h.find("Save") as string }], { app: FIXTURE_APP });
		await h.act([{ type: String(request.task.params.name).slice(0, 2), into: h.find("Name") as string }], { app: FIXTURE_APP });
		return undefined;
	},
	// Presses Wi-Fi twice: on, then off again.
	"fixture.wifi": async (h) => {
		await h.observe(FIXTURE_APP);
		await h.act([{ press: h.find("Wi-Fi") as string }, { press: h.find("Wi-Fi") as string }], { app: FIXTURE_APP });
		return undefined;
	},
	// Goes to the second page and back.
	"fixture.second-page": async (h) => {
		await h.observe(FIXTURE_APP);
		await h.act([{ press: h.find("Next") as string }], { app: FIXTURE_APP, expect: { text: "Second page" } });
		await h.observe(FIXTURE_APP);
		await h.act([{ press: h.find("Back") as string }], { app: FIXTURE_APP, expect: { text: "UI fixture" } });
		return undefined;
	},
	// Clicks twice, one short.
	"fixture.canvas": async (h) => {
		await h.observe(FIXTURE_APP);
		const canvas = h.find("Canvas") as string;
		await h.act([{ click: canvas }, { click: canvas }], { app: FIXTURE_APP, foreground: true });
		return undefined;
	},
};

const playing =
	(plays: Record<string, Play>): FakeAgent =>
	async (wire, request) => {
		const play = plays[request.task.task.spec.id];
		if (!play) return { outcome: "done", message: "this fake agent has no play for the task" };
		// Given code mode, the play is one script, as a code-mode agent writes it; given tools, a tool call per method.
		const answer = wire.script ? await wire.script((computer) => play(helper(computer), computer, request)) : await play(helper(wire), wire, request);
		return { outcome: "done", ...(answer === undefined ? {} : { answer }), cost_usd: 0 };
	};

/** The fake agents a dry run can name as an arm's harness: one that does each fake task right, one that does it
 *  plausibly wrong, and one that does nothing. */
export const FAKE_AGENTS: Record<string, FakeAgent> = {
	"fake-right": playing(RIGHT),
	"fake-wrong": playing(WRONG),
	"fake-null": async () => ({ outcome: "done", cost_usd: 0 }),
};

/** A helper for scripted fake agents, in the style of code mode: observe an app, find a node, act on it. */
export function helper(wire: Wire) {
	let last: { state: string; nodes: FakeNode[] } | undefined;
	const observe = async (app?: string) => {
		const result = await wire.call("ui.observe", app ? { target: { app } } : {});
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		last = result.value as { state: string; nodes: FakeNode[] };
		return last;
	};
	const find = (name: string) => last?.nodes.find((node) => node.name === name)?.ref;
	const act = async (steps: JsonObject[], more: { app?: string; expect?: JsonObject; foreground?: boolean } = {}) => {
		const result = await wire.call("ui.act", { ...(more.app ? { target: { app: more.app } } : {}), state: last?.state ?? "s0", steps, ...(more.expect ? { expect: more.expect } : {}), ...(more.foreground ? { foreground: true } : {}) });
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		return result.value as { steps: { route?: string; error?: { kind: string; message: string } }[]; state: string; changed: boolean; expect?: "met" | "unmet" };
	};
	return { observe, find, act, launch: (id: string) => wire.call("apps.launch", { id }) };
}
