// A fake of Orgo's Windows and macOS desktops, over fake-orgo.mjs's REST fake: the screenshot and the input calls with
// the request rules docs.orgo.ai gives for each (Windows refuses a field it does not take with 400 "Request failed with
// status code 400"), Orgo's bash call reading the provider's own commands (PowerShell on Windows, the shell on macOS),
// a file system in memory for the Windows files script and the upload's destPath, and the desktop fixture as the
// Windows one behaves: Start-Process of it logs ready, and a click, a drag or typed text inside its 200x200 window at
// (0, 0) is logged as it would log them, its four colors in the screenshot while it runs. Nothing reaches the network.
import { deflateSync, crc32 } from "node:zlib";
import { fakeOrgoApi } from "./fake-orgo.mjs";

export const WINDOWS_LABELS = "C:\\ProgramData\\agentrun\\labels.json";
export const MACOS_LABELS = "/Users/Shared/agentrun/labels.json";
export const WINDOWS_HOME = "C:\\Users\\agent";
const FILES_MARK = "# agentrun-computer: orgo-windows-files";
const W400 = { error: "Request failed with status code 400", upstream_status: 400 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FIXTURE_COLORS = [
	[255, 0, 0],
	[0, 255, 0],
	[0, 0, 255],
	[255, 255, 0],
];

/** An 8-bit RGB PNG of width x height, each pixel color(x, y). */
export function pngOf(width, height, color) {
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) rows.set(color(x, y), y * (width * 3 + 1) + 1 + x * 3);
	}
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed) >>> 0);
		return Buffer.concat([length, typed, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A Windows path as Windows reads it: either separator, no trailing one. */
const winPath = (path) => path.replaceAll("/", "\\").replace(/\\+$/, "");

/** The words of a PowerShell line, each single-quoted with '' for a quote. */
export function psWords(line) {
	return [...line.matchAll(/'((?:[^']|'')*)'/g)].map(([, word]) => word.replaceAll("''", "'"));
}

/** The words of a POSIX shell line: single quotes, backslash escapes, spaces between. */
export function shWords(line) {
	const words = [];
	let word;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'") {
			const end = line.indexOf("'", i + 1);
			word = (word ?? "") + line.slice(i + 1, end);
			i = end;
		} else if (c === "\\") {
			word = (word ?? "") + line[++i];
		} else if (c === " ") {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else word = (word ?? "") + c;
	}
	if (word !== undefined) words.push(word);
	return words;
}

/**
 * The fake. Options:
 *  - os: "windows" (default) or "macos";
 *  - width, height: the screen (default 1280x720);
 *  - user: what the provider's user command reads (Windows default "1001:1001", macOS "501:20");
 *  - notReady: how many bash calls a new computer answers 503 "Computer not ready" before it takes one;
 *  - exec: (argv, { cwd, env, box }) => { exitCode, stdout, stderr } | "timeout" | undefined, before the programs this
 *    fake knows (echo, exit, warn, sleep, id, powershell's USERPROFILE, Start-Process, taskkill.exe);
 *  - inputFails: (path, body) => an HTTP status an input call answers instead, or undefined;
 *  - api: fakeOrgoApi's options.
 * fake.boxOf(id) is a computer's state: files and dirs, inputs ({ path, body }), commands, fixture, labels at its path.
 */
export function fakeOrgoDesktop({ os = "windows", width = 1280, height = 720, user, notReady = 0, exec, inputFails = () => undefined, api: apiOptions = {} } = {}) {
	const windows = os === "windows";
	const boxes = new Map();
	const boxOf = (id) => {
		if (!boxes.has(id)) {
			boxes.set(id, {
				files: new Map(),
				dirs: new Set(windows ? ["C:", "C:\\Users", WINDOWS_HOME, "C:\\ProgramData"] : ["/Users", "/Users/Shared"]),
				inputs: [],
				commands: [],
				notReady,
				fixture: undefined,
				screens: 0,
			});
		}
		return boxes.get(id);
	};
	const labelsPath = windows ? WINDOWS_LABELS : MACOS_LABELS;
	const ran = (exitCode, stdout = "", stderr = "") => (windows ? { exit_code: exitCode, stdout, stderr, output: `${stdout}${stderr}` } : { exit_code: exitCode, output: `${stdout}${stderr}` });

	const run = (argv, { cwd, env, box }) => {
		const given = exec?.(argv, { cwd, env, box });
		if (given === "timeout") return windows ? { exit_code: 124, error: "timeout", stdout: "", stderr: "", output: "" } : { exit_code: -1, output: "" };
		if (given !== undefined) return ran(given.exitCode, given.stdout ?? "", given.stderr ?? "");
		const [program, ...args] = argv;
		switch (program) {
			case "echo":
				return ran(0, `${args.join(" ")}\n`);
			case "exit":
				return ran(Number(args[0]));
			case "warn":
				return ran(1, "", `${args.join(" ")}\n`);
			case "sleep":
				return windows ? { exit_code: 124, error: "timeout", stdout: "partial", stderr: "", output: "partial" } : { exit_code: -1, output: "" };
			case "pwd":
				return ran(0, `${cwd ?? (windows ? `${WINDOWS_HOME}\\Desktop` : "/Users/agent")}\n`);
			case "env":
				return ran(0, Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}\n`).join(""));
			case "id":
				return ran(0, args[0] === "-u" ? "501\n" : "20\n");
			case "powershell.exe":
				if (args.join(" ").includes("$env:USERPROFILE")) return ran(0, WINDOWS_HOME);
				break;
			case "Start-Process": {
				const files = /-File "([^"]+)" "([^"]+)"/.exec(args[1] ?? "");
				if (args[0] !== "powershell.exe" || files === null || !box.files.has(winPath(files[1]))) return ran(1, "", "Start-Process: the file is not there\n");
				box.fixture = { log: winPath(files[2]) };
				box.files.set(box.fixture.log, Buffer.from(`${JSON.stringify({ event: "ready", pid: 4242 })}\n`));
				return ran(0);
			}
			case "taskkill.exe":
				if (args[1] === "4242") box.fixture = undefined;
				return ran(0, "SUCCESS\n");
		}
		return ran(1, "", `${program}: the fake knows no such program\n`);
	};

	const logFixture = (box, event) => {
		if (box.fixture === undefined) return;
		const old = box.files.get(box.fixture.log) ?? Buffer.alloc(0);
		box.files.set(box.fixture.log, Buffer.concat([old, Buffer.from(`${JSON.stringify(event)}\n`)]));
	};
	const inFixture = (x, y) => x >= 0 && y >= 0 && x < 200 && y < 200;

	const bash = (id, command) => {
		const box = boxOf(id);
		box.commands.push(command);
		if (box.notReady > 0) {
			box.notReady--;
			return { httpStatus: 503, body: { error: "Computer not ready", request_id: "r1" } };
		}
		if (windows) {
			if (command.startsWith(FILES_MARK)) return filesOp(box, JSON.parse(Buffer.from(/FromBase64String\('([^']*)'\)/.exec(command)[1], "base64").toString("utf8")));
			const write = /FromBase64String\('([A-Za-z0-9+/=]*)'\)\)\n\$p = '([^']+)'/.exec(command);
			if (write) {
				box.files.set(write[2], Buffer.from(write[1], "base64"));
				return ran(0);
			}
			const read = /^\$p = '([^']+)'; if \(Test-Path/.exec(command);
			if (read) return box.files.has(read[1]) ? ran(0, box.files.get(read[1]).toString("utf8")) : ran(3);
			if (command.includes("WindowsIdentity")) return ran(0, user ?? "1001:1001");
			const lines = command.split("\n");
			const call = lines.find((line) => line.startsWith("& "));
			if (call) {
				const env = Object.fromEntries(lines.flatMap((line) => (line.startsWith("Set-Item -LiteralPath 'Env:") ? [psWords(line).map((w, i) => (i === 0 ? w.slice(4) : w))] : [])));
				const cwd = lines.find((line) => line.startsWith("Set-Location -LiteralPath "));
				return run(psWords(call.slice(2)), { cwd: cwd ? psWords(cwd)[0] : undefined, env, box });
			}
			return ran(1, "", "the fake reads no such PowerShell\n");
		}
		const write = /^mkdir -p '[^']*' && printf '%s' (.+) > '([^']+)\.part' && mv/.exec(command);
		if (write) {
			box.files.set(write[2], Buffer.from(shWords(write[1]).join(" ")));
			return ran(0);
		}
		const read = /^\[ -f '([^']+)' \] && cat/.exec(command);
		if (read) return box.files.has(read[1]) ? ran(0, box.files.get(read[1]).toString("utf8")) : ran(3);
		if (command.startsWith('printf "%s:%s" "$(id -u)"')) return ran(0, user ?? "501:20");
		let rest = command;
		let cwd;
		const cd = /^cd ('(?:[^']|'\\'')*') && /.exec(rest);
		if (cd) {
			cwd = shWords(cd[1])[0];
			rest = rest.slice(cd[0].length);
		}
		let words = shWords(rest);
		const env = {};
		if (words[0] === "env") {
			words = words.slice(1);
			while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
				const [name, ...value] = words.shift().split("=");
				env[name] = value.join("=");
			}
		}
		return run(words, { cwd, env, box });
	};

	/** The Windows files script's request, done on the box's files, answered as the script answers. */
	const filesOp = (box, p) => {
		const norm = winPath;
		const parent = (path) => path.slice(0, path.lastIndexOf("\\"));
		const say = (o) => ran(0, JSON.stringify(o));
		const no = (kind, words) => ran(2, JSON.stringify({ error: kind, message: words }));
		const statOf = (path) =>
			box.dirs.has(path) ? { type: "dir", size: 0, mode: 493, mtimeMs: 1, uid: 0, gid: 0 } : { type: "file", size: box.files.get(path).length, mode: 420, mtimeMs: 1, uid: 0, gid: 0 };
		const mkdirs = (path) => {
			for (let at = path; at !== "" && !box.dirs.has(at); at = parent(at)) box.dirs.add(at);
		};
		const children = (dir) => [...new Set([...box.dirs, ...box.files.keys()])].filter((path) => parent(path) === dir).sort();
		switch (p.op) {
			case "read": {
				const path = norm(p.path);
				if (box.dirs.has(path)) return no("is_dir", `${path} is a folder`);
				if (!box.files.has(path)) return no("not_found", `Could not find file '${path}'.`);
				const bytes = box.files.get(path);
				return say({ data: bytes.subarray(p.offset, p.offset + p.length).toString("base64"), size: bytes.length });
			}
			case "write": {
				const path = norm(p.path);
				if (box.dirs.has(path)) return no("is_dir", `${path} is a folder`);
				if (!box.dirs.has(parent(path))) {
					if (!p.parents) return no("not_found", `no folder ${parent(path)}`);
					mkdirs(parent(path));
				}
				let bytes;
				if (p.staged) {
					bytes = box.files.get(p.staged);
					box.files.delete(p.staged);
				} else bytes = Buffer.from(p.data, "base64");
				const old = box.files.get(path) ?? Buffer.alloc(0);
				let next;
				if (p.append) next = Buffer.concat([old, bytes]);
				else if (p.offset !== undefined) {
					next = Buffer.alloc(Math.max(old.length, p.offset + bytes.length));
					old.copy(next);
					bytes.copy(next, p.offset);
				} else next = bytes;
				box.files.set(path, next);
				return say({ size: next.length });
			}
			case "stat": {
				const path = norm(p.path);
				return box.dirs.has(path) || box.files.has(path) ? say(statOf(path)) : no("not_found", `Cannot find path '${path}' because it does not exist.`);
			}
			case "list": {
				const path = norm(p.path);
				if (!box.dirs.has(path)) return box.files.has(path) ? no("not_dir", `${path} is not a folder`) : no("not_found", `no folder ${path}`);
				const all = [];
				const walk = (dir, level) => {
					for (const child of children(dir)) {
						all.push({ ...statOf(child), path: child });
						if (box.dirs.has(child) && level < p.depth) walk(child, level + 1);
					}
				};
				walk(path, 1);
				const page = all.slice(p.offset, p.offset + p.max);
				// PowerShell's ConvertTo-Json writes a list of one as the one object, and none as nothing at all.
				return say({ entries: page.length === 1 ? page[0] : page.length === 0 ? null : page, truncated: all.length > p.offset + p.max });
			}
			case "mkdir": {
				const path = norm(p.path);
				if (box.dirs.has(path) || box.files.has(path)) return p.parents && box.dirs.has(path) ? say({}) : no("exists", `${path} is there already`);
				if (!p.parents && !box.dirs.has(parent(path))) return no("not_found", `no folder ${parent(path)}`);
				mkdirs(path);
				return say({});
			}
			case "move": {
				const from = norm(p.from);
				const to = norm(p.to);
				if (!box.files.has(from) && !box.dirs.has(from)) return no("not_found", `no ${from}`);
				if ((box.files.has(to) || box.dirs.has(to)) && !p.overwrite) return no("exists", `${to} is there already`);
				if (box.files.has(from)) {
					box.files.set(to, box.files.get(from));
					box.files.delete(from);
				} else {
					for (const dir of [...box.dirs]) if (dir === from || dir.startsWith(`${from}\\`)) (box.dirs.delete(dir), box.dirs.add(to + dir.slice(from.length)));
					for (const [file, bytes] of [...box.files]) if (file.startsWith(`${from}\\`)) (box.files.delete(file), box.files.set(to + file.slice(from.length), bytes));
				}
				return say({});
			}
			case "remove": {
				const path = norm(p.path);
				if (box.files.has(path)) {
					box.files.delete(path);
					return say({});
				}
				if (!box.dirs.has(path)) return no("not_found", `no ${path}`);
				if (children(path).length > 0 && !p.recursive) return no("invalid", `${path} is a folder that is not empty: remove it with recursive`);
				for (const dir of [...box.dirs]) if (dir === path || dir.startsWith(`${path}\\`)) box.dirs.delete(dir);
				for (const file of [...box.files.keys()]) if (file.startsWith(`${path}\\`)) box.files.delete(file);
				return say({});
			}
		}
		return no("unsupported", `${p.op} is not a files method`);
	};

	/** What a desktop's screen shows: a gray-blue background, and the fixture's four colors while it runs. */
	const screen = (box, w, h) =>
		pngOf(w, h, (x, y) => {
			const [sx, sy] = [Math.floor((x * width) / w), Math.floor((y * height) / h)];
			if (box.fixture !== undefined && inFixture(sx, sy)) return FIXTURE_COLORS[(sy >= 100 ? 2 : 0) + (sx >= 100 ? 1 : 0)];
			return [30, 60, 90];
		});

	const only = (body, fields) => Object.keys(body ?? {}).every((field) => fields.includes(field));
	const extra = ({ method, path, query, body, record }) => {
		const action = /^\/computers\/[^/]+\/([a-z-]+)$/.exec(path)?.[1];
		if (record === undefined || action === undefined) return undefined;
		const box = boxOf(record.id);
		if (method === "GET" && action === "screenshot") {
			const scale = query.scale === undefined ? 1 : Number(query.scale);
			const [w, h] = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
			box.screens++;
			return json(200, { success: true, image: screen(box, w, h).toString("base64"), mime_type: "image/png", width: w, height: h });
		}
		if (method !== "POST" || !["click", "mouse-move", "drag", "type", "key", "scroll"].includes(action)) return undefined;
		box.inputs.push({ path: action, body });
		const failed = inputFails(action, body);
		if (failed !== undefined) return json(failed, windows ? W400 : { error: "the fake refused it" });
		const whole = (v) => Number.isSafeInteger(v) && v >= 0;
		if (windows) {
			const fits =
				action === "click"
					? only(body, ["x", "y", "button", "double"]) && whole(body.x) && whole(body.y) && ["left", "right", "middle", undefined].includes(body.button)
					: action === "mouse-move"
						? only(body, ["x", "y"]) && whole(body.x) && whole(body.y)
						: action === "drag"
							? only(body, ["start_x", "start_y", "end_x", "end_y", "button"]) && [body.start_x, body.start_y, body.end_x, body.end_y].every(whole)
							: action === "type"
								? only(body, ["text"]) && Buffer.byteLength(body.text ?? "") <= 20_000
								: action === "key"
									? only(body, ["key"]) && typeof body.key === "string" && body.key !== ""
									: only(body, ["direction", "amount"]) && ["up", "down"].includes(body.direction) && Number.isSafeInteger(body.amount) && body.amount >= 1 && body.amount <= 50;
			if (!fits) return json(400, W400);
		}
		const button = body.button ?? "left";
		if (action === "click" && inFixture(body.x, body.y)) {
			for (let n = 0; n < (body.double ? 2 : (body.repeat ?? 1)); n++) {
				logFixture(box, { event: "down", button, at: [body.x, body.y] });
				logFixture(box, { event: "up", button, at: [body.x, body.y] });
			}
		}
		if (action === "drag") {
			if (inFixture(body.start_x, body.start_y)) logFixture(box, { event: "down", button, at: [body.start_x, body.start_y] });
			if (inFixture(body.end_x, body.end_y)) logFixture(box, { event: "up", button, at: [body.end_x, body.end_y] });
		}
		if (action === "type") for (const character of body.text ?? "") logFixture(box, { event: "text", text: character });
		return json(200, windows ? { ok: true } : { success: true, action, details: body, error: null, error_type: null });
	};
	const upload = async (form) => {
		const record = api.computers.get(form.get("desktopId"));
		if (record === undefined) return;
		const file = form.get("file");
		const box = boxOf(record.id);
		const folder = String(form.get("destPath"));
		box.dirs.add(folder);
		box.files.set(`${folder}\\${file.name}`, Buffer.from(await file.arrayBuffer()));
	};
	const api = fakeOrgoApi({ bash, extra, upload, ...apiOptions });
	return { api, fetch: api.fetch, boxes, boxOf, labelsPath };
}
