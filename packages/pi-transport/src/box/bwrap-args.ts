/**
 * The bwrap box's arguments: the argv that runs one command of a box under bubblewrap on Linux, built from an allowlist
 * and checked against it before anything is spawned, and the probe that says whether this host can run such a box and,
 * when it cannot, why.
 *
 * A bwrap box is a directory on this host, its workspace. Each `exec` runs `bwrap <these arguments> -- <command>` in new
 * user, pid, mount, network, IPC, UTS and cgroup namespaces, where the program has:
 * - the workspace, bound read-write at the box's working directory: the one host directory it can write;
 * - the system read-only (`/usr`, the `/bin`, `/sbin` and `/lib*` beside it or linked into it, and a named part of
 *   `/etc`), a private `/proc`, `/dev` and `/tmp`, and the root itself remounted read-only;
 * - its own `/etc/passwd`, `/etc/group` and `/etc/hosts`, which the spawner writes on fixed descriptors (`bwrapFiles`);
 * - nothing else of the host: no home, no data root, no `/run`, no socket;
 * - no network but a loopback of its own (`--unshare-net`). `open` would share this host's network namespace, its
 *   loopback services and abstract sockets included, so it is refused, and so is an allowlist;
 * - no capability (`--cap-drop ALL`), no further user namespace (`--disable-userns`), a session of its own, a hostname
 *   of its own, and death with the process that spawned bwrap (`--die-with-parent`);
 * - an environment made from the spec alone (`--clearenv`, then `--setenv` pairs), never this process's.
 *
 * Its isolation is `namespace`: Linux namespaces over this host's kernel, with this host's system read-only. It is not a
 * `container` (no image, no cgroup limits, no seccomp filter) and it is more than `none`.
 */
import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import {
	accessSync,
	constants,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { posix } from "node:path";
import type { Writable } from "node:stream";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { BoxError, type BoxSpec } from "./box.ts";

/** The oldest bubblewrap a box runs on: 0.8.0 is the first with `--disable-userns`, which every box carries. */
export const BWRAP_MIN_VERSION = "0.8.0";

/** Where programs start when the spec names no workspace. */
export const BWRAP_WORKDIR = "/workspace";

/** The `PATH` of programs in a box when the spec's `env` names none. This process's own `PATH` is never used. */
export const BWRAP_PATH = "/usr/local/bin:/usr/bin:/bin";

/** The box's hostname, so a program in it never reads this host's. */
export const BWRAP_HOSTNAME = "box";

/** The system, read-only: these directories, or the links a merged-`/usr` host has in their place. */
export const BWRAP_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const;

/**
 * The part of `/etc` a program needs, read-only, each only where this host has it: the alternatives links (`awk`,
 * `editor`), the CA certificates, the dynamic linker's cache, the time zone and the name service switch. Never `/etc`
 * whole, and never `/etc/passwd`, `/etc/group` or `/etc/hosts`, which the box gets from `bwrapFiles` instead.
 */
export const BWRAP_ETC = [
	"/etc/alternatives",
	"/etc/ca-certificates",
	"/etc/ld.so.cache",
	"/etc/localtime",
	"/etc/nsswitch.conf",
	"/etc/ssl/certs",
] as const;

/** The files a box gets on fixed descriptors, as `[fd, path]`. The spawner writes each (`bwrapFiles`) and closes it. */
export const BWRAP_DATA = [
	[3, "/etc/passwd"],
	[4, "/etc/group"],
	[5, "/etc/hosts"],
] as const;

/** The flags every box carries, each once. */
export const BWRAP_FLAGS = [
	"--unshare-user",
	"--unshare-pid",
	"--unshare-net",
	"--unshare-ipc",
	"--unshare-uts",
	"--unshare-cgroup-try",
	"--disable-userns",
	"--die-with-parent",
	"--new-session",
] as const;

/** The box's own mounts, made before any bind so that none of them hides one (a workspace under `/tmp`). */
const PRIVATE = [
	["--proc", "/proc"],
	["--dev", "/dev"],
	["--tmpfs", "/tmp"],
	["--tmpfs", "/dev/shm"],
] as const;

/**
 * Host paths a workspace is never, never lies under and never holds: the system, its configuration, the kernel's
 * interfaces, the runtime state with its sockets, and root's home. The server's home and the caller's hidden paths join
 * them.
 */
const NEVER_UNDER = ["/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/root", ...BWRAP_SYSTEM] as const;

/** Host paths a workspace is never and never holds, though a directory below one may be a workspace. */
const NEVER_HOLDS = ["/", "/home", "/var", "/tmp", "/var/tmp", "/srv", "/data", "/opt", "/mnt", "/media"] as const;

/** Where the box's working directory may not be: the box mounts these itself. `/tmp` itself neither; below it may. */
const BOX_MOUNTED = [...BWRAP_SYSTEM, "/etc", "/proc", "/dev", "/sys"] as const;

/** The options a bwrap box uses, by the number of operands each takes. Any other option in an argv is refused. */
const ARITY: Readonly<Record<string, number>> = {
	...Object.fromEntries(BWRAP_FLAGS.map((flag) => [flag, 0])),
	"--clearenv": 0,
	"--cap-drop": 1,
	"--hostname": 1,
	"--proc": 1,
	"--dev": 1,
	"--tmpfs": 1,
	"--remount-ro": 1,
	"--chdir": 1,
	"--ro-bind": 2,
	"--bind": 2,
	"--symlink": 2,
	"--ro-bind-data": 2,
	"--setenv": 2,
};

const MOUNTS = new Set([
	"--proc",
	"--dev",
	"--tmpfs",
	"--remount-ro",
	"--ro-bind",
	"--bind",
	"--symlink",
	"--ro-bind-data",
]);
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What the builder reads of a box's spec. */
export type BwrapSpec = Pick<BoxSpec, "env" | "network" | "workspace">;

/** This host's filesystem as the builder reads it. Tests give their own. */
export type BwrapHostFs = {
	/** What is at `path`, a link not followed; `null` when nothing is. */
	kind(path: string): "dir" | "file" | "link" | "other" | null;
	/** A link's target as it is written. */
	link(path: string): string;
	/** `path` with every link in it followed, or `undefined` when it leads nowhere. */
	real(path: string): string | undefined;
};

/** What the builder takes of the host side of one exec. */
export type BwrapHost = {
	/** The host directory that is the box's workspace: absolute, in normal form, an existing directory. */
	readonly workspace: string;
	/** The program and its arguments, run without a shell. */
	readonly command: readonly string[];
	/** Host paths no box may see, such as the provider's own records: a workspace that is one, holds one or lies under one is refused. */
	readonly hidden?: readonly string[];
	/** The server's home directories; default this process's `HOME` and its user's home. A workspace never lies in one. */
	readonly homes?: readonly string[];
	/** For tests: the host's filesystem (default the real one). */
	readonly fs?: BwrapHostFs;
};

const realFs: BwrapHostFs = {
	kind(path) {
		try {
			const stat = lstatSync(path);
			return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
		} catch {
			return null;
		}
	},
	link: (path) => readlinkSync(path),
	real(path) {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	},
};

const invalid = (message: string) => new BoxError("invalid", message);

/** Whether `path` is `root` or lies under it, at a `/` boundary. */
const isUnder = (path: string, root: string): boolean =>
	path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** Why `path` is not an absolute path in normal form, or `undefined` when it is one. */
function shapeRefusal(path: unknown, what: string): BoxError | undefined {
	if (typeof path !== "string" || path === "") return invalid(`${what} is not a path`);
	if ([...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
		return invalid(`${what} ${JSON.stringify(path)} holds a control character`);
	}
	if (!path.startsWith("/")) return invalid(`${what} ${JSON.stringify(path)} is not an absolute path`);
	if (path.split("/").includes("..")) return invalid(`${what} ${JSON.stringify(path)} has a .. segment`);
	if (posix.normalize(path) !== path || (path !== "/" && path.endsWith("/"))) {
		return invalid(`${what} ${JSON.stringify(path)} is not in normal form`);
	}
	return undefined;
}

/** The roots a workspace is checked against, each as given and as resolved. */
type Forbidden = { readonly under: readonly string[]; readonly holds: readonly string[] };

function forbiddenRoots(host: BwrapHost, fs: BwrapHostFs): Forbidden | BoxError {
	const both = (path: string) => {
		const real = fs.real(path);
		return real === undefined || real === path ? [path] : [path, real];
	};
	// A home of `/` (a service user's) protects nothing a root of its own would not: `/` is never bound whole.
	const homes = (host.homes ?? defaultHomes()).filter((home) => home !== "/");
	const named = [
		...homes.map((path) => ["a home", path] as const),
		...(host.hidden ?? []).map((path) => ["a hidden path", path] as const),
	];
	// A path to protect that is not absolute is refused, never passed over: passing it over would bind what it names.
	for (const [what, path] of named) {
		if (typeof path !== "string" || !path.startsWith("/"))
			return invalid(`${what} ${JSON.stringify(path)} is not an absolute path`);
	}
	return {
		under: [...NEVER_UNDER, ...named.map(([, path]) => posix.resolve(path)).flatMap(both)],
		holds: [...NEVER_HOLDS],
	};
}

function defaultHomes(): string[] {
	const homes = [homedir()];
	try {
		homes.push(userInfo().homedir);
	} catch {
		// no passwd entry for this uid: its HOME is the one home known
	}
	return [...new Set(homes)];
}

/** Why the host path `path` may not be bound into a box, or `undefined` when it may. */
function placeRefusal(path: string, roots: Forbidden, what: string): BoxError | undefined {
	const all = [...roots.under, ...roots.holds];
	const exact = all.find((root) => path === root);
	if (exact !== undefined) return invalid(`${what} ${path} is ${exact}, which a box never sees`);
	const held = all.find((root) => isUnder(root, path));
	if (held !== undefined) return invalid(`${what} ${path} holds ${held}, which a box never sees`);
	const above = roots.under.find((root) => isUnder(path, root));
	if (above !== undefined) return invalid(`${what} ${path} lies under ${above}, which a box never sees`);
	return undefined;
}

/** The host directory bound as the workspace: the path as resolved, checked as given and as resolved. */
function workspaceSource(host: BwrapHost, fs: BwrapHostFs): string | BoxError {
	const path = host.workspace;
	const shape = shapeRefusal(path, "the workspace");
	if (shape !== undefined) return shape;
	const roots = forbiddenRoots(host, fs);
	if (roots instanceof BoxError) return roots;
	const given = placeRefusal(path, roots, "the workspace");
	if (given !== undefined) return given;
	const real = fs.real(path);
	if (real === undefined) return invalid(`the workspace ${path} does not exist`);
	if (real !== path) {
		const resolved = placeRefusal(real, roots, `the workspace ${path}, through its links,`);
		if (resolved !== undefined) return resolved;
	}
	if (fs.kind(real) !== "dir") return invalid(`the workspace ${path} is not a directory`);
	return real;
}

/** The box's working directory, where the workspace is bound and programs start. */
function boxWorkdir(workspace: string | undefined): string | BoxError {
	const path = workspace ?? BWRAP_WORKDIR;
	const shape = shapeRefusal(path, "the box's workspace");
	if (shape !== undefined) return shape;
	if (path === "/" || path === "/tmp") return invalid(`the box's workspace may not be ${path}`);
	if (path.includes(":")) {
		return invalid(`the box's workspace ${path} holds a colon, which would split its user's home in /etc/passwd`);
	}
	for (const root of BOX_MOUNTED) {
		if (isUnder(path, root))
			return invalid(`the box's workspace ${path} lies in ${root}, which the box mounts itself`);
	}
	return path;
}

/** The whole environment of a box's programs: the default `PATH` and `HOME`, then the spec's. */
function boxEnv(spec: BwrapSpec, workdir: string): Map<string, string> | BoxError {
	const env = new Map<string, string>([
		["PATH", BWRAP_PATH],
		["HOME", workdir],
	]);
	for (const [name, value] of Object.entries(spec.env ?? {})) {
		if (!VARIABLE.test(name)) return invalid(`the environment name ${JSON.stringify(name)} is not a variable name`);
		if (typeof value !== "string" || value.includes("\0")) {
			return invalid(`the environment variable ${name} is not a string without NUL bytes`);
		}
		env.set(name, value);
	}
	return env;
}

/** The read-only system: a directory bound as resolved, or a merged-`/usr` link made again in the box. */
function systemMounts(fs: BwrapHostFs): string[][] | BoxError {
	const mounts: string[][] = [];
	for (const path of BWRAP_SYSTEM) {
		const kind = fs.kind(path);
		if (kind === "link") {
			const target = fs.link(path);
			const resolved = posix.resolve(posix.dirname(path), target);
			if (!isUnder(resolved, "/usr")) return invalid(`this host's ${path} links to ${target}, outside /usr`);
			mounts.push(["--symlink", target, path]);
		} else if (kind === "dir") {
			const real = fs.real(path);
			if (real === undefined || (real !== path && !isUnder(real, "/usr"))) {
				return invalid(`this host's ${path} resolves to ${real ?? "nothing"}, outside its system`);
			}
			mounts.push(["--ro-bind", real, path]);
		}
	}
	for (const path of BWRAP_ETC) {
		if (fs.kind(path) === null) continue;
		const real = fs.real(path);
		// A link that leads nowhere (a time zone not installed) is left out, as a path the host lacks is.
		if (real === undefined) continue;
		if (real !== path && !isUnder(real, "/usr") && !(isUnder(real, "/etc") && real !== "/etc")) {
			return invalid(`this host's ${path} resolves to ${real}, outside /etc and /usr`);
		}
		mounts.push(["--ro-bind", real, path]);
	}
	return mounts;
}

/**
 * The whole argv of `bwrap` for one command of a box, its own path not included: the flags, the box's own mounts, the
 * system read-only, the files on descriptors, the workspace, the root remounted read-only, the working directory, the
 * environment, `--` and the command.
 *
 * `unsupported` for a network other than `none` (absent means `none`); `invalid` for a workspace, a working directory,
 * an environment or a command it will not build. Nothing is spawned.
 */
export function bwrapArgs(spec: BwrapSpec, host: BwrapHost): Result<string[], BoxError> {
	const fs = host.fs ?? realFs;
	const network = spec.network ?? "none";
	if (network !== "none") {
		const asked = typeof network === "string" ? network : "an allowlist";
		return err(
			new BoxError("unsupported", `a bwrap box has no network but its own loopback, and the spec asks for ${asked}`),
		);
	}
	const workdir = boxWorkdir(spec.workspace);
	if (workdir instanceof BoxError) return err(workdir);
	const source = workspaceSource(host, fs);
	if (source instanceof BoxError) return err(source);
	const env = boxEnv(spec, workdir);
	if (env instanceof BoxError) return err(env);
	const command = host.command;
	if (!Array.isArray(command) || command.length === 0 || command[0] === "") {
		return err(invalid("the command is empty"));
	}
	if (command.some((part) => typeof part !== "string" || part.includes("\0"))) {
		return err(invalid("the command holds a part that is not a string without NUL bytes"));
	}
	const system = systemMounts(fs);
	if (system instanceof BoxError) return err(system);
	return ok([
		...BWRAP_FLAGS,
		"--cap-drop",
		"ALL",
		"--hostname",
		BWRAP_HOSTNAME,
		...PRIVATE.flat(),
		...system.flat(),
		...BWRAP_DATA.flatMap(([fd, path]) => ["--ro-bind-data", String(fd), path]),
		"--bind",
		source,
		workdir,
		"--remount-ro",
		"/",
		"--chdir",
		workdir,
		"--clearenv",
		...[...env].flatMap(([name, value]) => ["--setenv", name, value]),
		"--",
		...command,
	]);
}

/**
 * What the spawner writes on each of `BWRAP_DATA`'s descriptors, then closes: a passwd and a group naming the box's one
 * user (this host's uid and gid, which bwrap keeps), with the working directory as its home, and a hosts file that names
 * only the loopback and the box's hostname.
 */
export function bwrapFiles(
	workdir: string,
	ids: { readonly uid: number; readonly gid: number } = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
): readonly (readonly [fd: number, text: string])[] {
	return [
		[3, `box:x:${ids.uid}:${ids.gid}:box:${workdir}:/bin/sh\n`],
		[4, `box:x:${ids.gid}:\n`],
		[5, `127.0.0.1\tlocalhost\n127.0.1.1\t${BWRAP_HOSTNAME}\n::1\tlocalhost ip6-localhost ip6-loopback\n`], // key-gate: loopback-rule the generated /etc/hosts of the box names only its loopback
	];
}

/**
 * Checks an argv against the allowlist, structurally and then exactly: `undefined` when it may be spawned, otherwise
 * `invalid` naming the first fault. The rules hold whatever built the argv: every flag once, `--cap-drop ALL`, the
 * box's own mounts before any bind, the system read-only and only it, one writable bind and that one the working
 * directory, the files only on their descriptors, the root remounted read-only after the last mount, `--clearenv` before
 * every `--setenv`, no option outside the set this module uses, and a command after `--`. Then the argv must be the one
 * `bwrapArgs` builds for `spec` and `host`, element by element.
 */
export function checkBwrapArgs(argv: readonly string[], spec: BwrapSpec, host: BwrapHost): BoxError | undefined {
	const refuse = (why: string) => invalid(`the bwrap argv is refused: ${why}`);
	const seen = new Map<string, number>();
	const mounts: string[][] = [];
	const names = new Set<string>();
	let cleared = false;
	let chdir: string | undefined;
	let at = 0;
	while (at < argv.length && argv[at] !== "--") {
		const option = argv[at]!;
		const arity = Object.hasOwn(ARITY, option) ? ARITY[option] : undefined;
		if (arity === undefined) return refuse(`${JSON.stringify(option)} is not an option a bwrap box uses`);
		const operands = argv.slice(at + 1, at + 1 + arity);
		if (operands.length !== arity) return refuse(`${option} is missing its operands`);
		seen.set(option, (seen.get(option) ?? 0) + 1);
		if (MOUNTS.has(option)) {
			mounts.push([option, ...operands]);
		} else if (option === "--setenv") {
			if (!cleared) return refuse("--setenv before --clearenv");
			if (!VARIABLE.test(operands[0]!))
				return refuse(`--setenv ${JSON.stringify(operands[0])} is not a variable name`);
			if (names.has(operands[0]!)) return refuse(`--setenv ${operands[0]} twice`);
			names.add(operands[0]!);
		} else {
			if (seen.get(option)! > 1) return refuse(`${option} twice`);
			if (option === "--clearenv") cleared = true;
			if (option === "--cap-drop" && operands[0] !== "ALL") return refuse(`--cap-drop ${operands[0]} is not ALL`);
			if (option === "--hostname" && operands[0] !== BWRAP_HOSTNAME) {
				return refuse(`--hostname ${operands[0]} is not the box's own`);
			}
			if (option === "--chdir") chdir = operands[0];
		}
		at += 1 + arity;
	}
	if (argv[at] !== "--" || at + 1 >= argv.length) return refuse("no command after --");
	for (const required of [...BWRAP_FLAGS, "--clearenv", "--cap-drop", "--hostname", "--chdir"]) {
		if (!seen.has(required)) return refuse(`${required} is missing`);
	}
	const mountFault = mountRefusal(mounts, chdir!, host);
	if (mountFault !== undefined) return refuse(mountFault);
	const built = bwrapArgs(spec, host);
	if (!built.ok) return built.error;
	const expected = built.value;
	const differs = Math.max(argv.length, expected.length);
	for (let n = 0; n < differs; n++) {
		if (argv[n] !== expected[n]) {
			return refuse(
				`it is not the argv built for this box: at ${n} it has ${JSON.stringify(argv[n] ?? null)} where ${JSON.stringify(expected[n] ?? null)} was built`,
			);
		}
	}
	return undefined;
}

/** The first fault of an argv's mounts, or `undefined`. */
function mountRefusal(mounts: readonly string[][], chdir: string, host: BwrapHost): string | undefined {
	const count = (option: string, ...operands: string[]) =>
		mounts.filter((m) => m[0] === option && operands.every((operand, n) => m[n + 1] === operand)).length;
	for (const [option, path] of PRIVATE) {
		if (count(option, path) !== 1) return `${option} ${path} is missing or made twice`;
	}
	const binds = mounts.filter((m) => m[0] === "--bind");
	if (binds.length !== 1) {
		return `a box has one --bind, its workspace, and this argv has ${binds.length}${binds.length > 1 ? ` (${binds.map((m) => `${m[1]} to ${m[2]}`).join(", ")})` : ""}`;
	}
	const destinations = new Set<string>();
	for (const [n, mount] of mounts.entries()) {
		const [option, first, second] = mount as [string, string, string | undefined];
		if (option === "--proc" || option === "--dev" || option === "--tmpfs") {
			if (!PRIVATE.some(([o, p]) => o === option && p === first))
				return `${option} ${first} is not one of the box's own mounts`;
			// A mount made after a bind under it hides that bind.
			const hidden = mounts
				.slice(0, n)
				.find(
					(earlier) =>
						MOUNTS.has(earlier[0]!) &&
						earlier[0] !== "--proc" &&
						earlier[0] !== "--dev" &&
						earlier[0] !== "--tmpfs" &&
						isUnder(earlier.at(-1)!, first),
				);
			if (hidden !== undefined)
				return `${option} ${first} comes after ${hidden[0]} to ${hidden.at(-1)}, which it would hide`;
			continue;
		}
		if (option === "--remount-ro") {
			if (first !== "/") return `--remount-ro ${first} is not the root`;
			if (n !== mounts.length - 1) return "--remount-ro / is not the last mount";
			continue;
		}
		// --bind, --ro-bind, --symlink and --ro-bind-data: one mount at each destination, every path in normal form.
		const destination = second!;
		const shape = shapeRefusal(destination, `${option}'s destination`);
		if (shape !== undefined) return shape.message;
		if (option !== "--symlink" && option !== "--ro-bind-data") {
			const source = shapeRefusal(first, `${option}'s source`);
			if (source !== undefined) return source.message;
		}
		if (destinations.has(destination)) return `${option} to ${destination} twice`;
		destinations.add(destination);
		if (option === "--ro-bind-data") {
			if (!BWRAP_DATA.some(([fd, path]) => String(fd) === first && path === second)) {
				return `--ro-bind-data ${first} ${second} is not one of the box's files`;
			}
			continue;
		}
		if (option === "--symlink") {
			if (!(BWRAP_SYSTEM as readonly string[]).includes(second!))
				return `--symlink to ${second} is not a system link`;
			if (!isUnder(posix.resolve(posix.dirname(second!), first), "/usr"))
				return `--symlink ${first} ${second} leads outside /usr`;
			continue;
		}
		if (option === "--ro-bind") {
			const system = (BWRAP_SYSTEM as readonly string[]).includes(second!);
			const etc = (BWRAP_ETC as readonly string[]).includes(second!);
			if (!system && !etc) return `--ro-bind to ${second} is not the system's`;
			const from = first === second || isUnder(first, "/usr") || (etc && isUnder(first, "/etc") && first !== "/etc");
			if (!from) return `--ro-bind ${first} to ${second} binds a host path outside the system`;
			continue;
		}
		// --bind: the workspace, at the working directory.
		if (second !== chdir) return `--bind ${first} to ${second} is not at the working directory ${chdir}`;
		const roots = forbiddenRoots(host, host.fs ?? realFs);
		if (roots instanceof BoxError) return roots.message;
		const place = placeRefusal(first, roots, "the workspace");
		if (place !== undefined) return place.message;
	}
	if (count("--remount-ro", "/") !== 1) return "--remount-ro / is missing";
	for (const [fd, path] of BWRAP_DATA) {
		if (count("--ro-bind-data", String(fd), path) !== 1) return `--ro-bind-data ${fd} ${path} is missing`;
	}
	return undefined;
}

/** Why a host cannot run a bwrap box. */
export type BwrapUnavailable =
	/** Not Linux. */
	| "platform"
	/** No executable `bwrap`. */
	| "missing"
	/** A setuid `bwrap`, which a box never runs. */
	| "setuid"
	/** A version that cannot be read, or one older than `BWRAP_MIN_VERSION`. */
	| "version"
	/** The host denies bwrap a user namespace (AppArmor's restriction of unprivileged user namespaces, or a sysctl). */
	| "userns_denied"
	/** A run did not end within the probe's bound and was killed. */
	| "timeout"
	/** Anything else: what bwrap said is in the reason. */
	| "failed";

/** Whether this host can run a bwrap box: the `bwrap` the probe ran and its version, or why not. */
export type BwrapProbe =
	| { readonly available: true; readonly bwrap: string; readonly version: string }
	| { readonly available: false; readonly code: BwrapUnavailable; readonly reason: string };

export type BwrapProbeOptions = {
	/** The `bwrap` to probe, an absolute path. Default: the first executable `bwrap` on `path`. */
	readonly bwrap?: string;
	/** The `PATH` searched for `bwrap`. Default this process's `PATH`. */
	readonly path?: string;
	/** How long each of the probe's two runs may take before it is killed. Default 5000 ms. */
	readonly timeoutMs?: number;
	/** Where the probe makes its box's workspace, which it removes. Default the OS's temporary directory. */
	readonly scratch?: string;
	/** For tests: the platform (default this process's). */
	readonly platform?: NodeJS.Platform;
	/** For tests: a sysctl's value, such as `kernel.apparmor_restrict_unprivileged_userns`, or `undefined` (default: read from `/proc/sys`). */
	readonly sysctl?: (name: string) => string | undefined;
};

/** What bwrap says when the host denies it a user namespace, or the powers it needs in one. */
const USERNS_DENIED =
	/setting up [ug]id map: Permission denied|No permissions to creat(?:e|ing) new namespace|unprivileged user namespaces|Creating new namespace failed: Operation not permitted|loopback: Failed RTM_NEWADDR: Operation not permitted/i;

/**
 * Whether this host can run a bwrap box, by reading and running bwrap, never by changing anything: the platform, an
 * executable `bwrap` that is not setuid, `bwrap --version` at `BWRAP_MIN_VERSION` or later, and one box built by
 * `bwrapArgs` exactly as an exec's is, running `true`. Each run is bounded by `timeoutMs` and killed with its process
 * group at the bound. A host that denies bwrap a user namespace is `userns_denied`, with the setting that denies it
 * where `/proc/sys` names one.
 */
export async function probeBwrap(options: BwrapProbeOptions = {}): Promise<BwrapProbe> {
	const no = (code: BwrapUnavailable, reason: string): BwrapProbe => ({ available: false, code, reason });
	const platform = options.platform ?? process.platform;
	if (platform !== "linux") return no("platform", `a bwrap box runs on Linux, and this host is ${platform}`);
	const bwrap = options.bwrap ?? onPath("bwrap", options.path ?? process.env.PATH ?? "");
	if (bwrap === undefined) {
		return no("missing", "bwrap is not installed: no executable bwrap is on PATH (install the bubblewrap package)");
	}
	if (!bwrap.startsWith("/")) return no("missing", `${JSON.stringify(bwrap)} is not an absolute path to bwrap`);
	let mode: number;
	try {
		const stat = statSync(bwrap);
		if (!stat.isFile()) return no("missing", `${bwrap} is not a file`);
		mode = stat.mode;
	} catch {
		return no("missing", `${bwrap} does not exist`);
	}
	if ((mode & 0o4000) !== 0) {
		return no(
			"setuid",
			`${bwrap} is setuid: a box never runs a setuid bwrap, which cannot refuse the box further user namespaces (install the distribution's bubblewrap, which is not setuid)`,
		);
	}
	const timeoutMs = options.timeoutMs ?? 5000;
	const asked = await run(bwrap, ["--version"], timeoutMs);
	if (asked.timedOut) return no("timeout", `${bwrap} --version did not answer within ${timeoutMs} ms and was killed`);
	if (asked.error !== undefined || asked.code !== 0) {
		return no("failed", `${bwrap} --version ${ended(asked)}: ${said(asked.stderr || asked.stdout)}`);
	}
	const named = /^bubblewrap (\d+)\.(\d+)\.(\d+)/m.exec(asked.stdout);
	if (named === null)
		return no("version", `${bwrap} --version said ${said(asked.stdout)}, which names no bubblewrap version`);
	const version = named.slice(1, 4).join(".");
	if (older(named.slice(1, 4).map(Number), BWRAP_MIN_VERSION.split(".").map(Number))) {
		return no(
			"version",
			`bwrap ${version} is older than ${BWRAP_MIN_VERSION}, the first with --disable-userns, which every box carries`,
		);
	}
	let scratch: string;
	try {
		scratch = mkdtempSync(posix.join(options.scratch ?? tmpdir(), "bwrap-probe-"));
	} catch (error) {
		return no("failed", `the probe could not make its box's workspace: ${(error as Error).message}`);
	}
	try {
		const host: BwrapHost = { workspace: scratch, command: ["true"] };
		const argv = bwrapArgs({}, host);
		if (!argv.ok) return no("failed", `the probe's own box is refused: ${argv.error.message}`);
		const refused = checkBwrapArgs(argv.value, {}, host);
		if (refused !== undefined) return no("failed", `the probe's own box is refused: ${refused.message}`);
		const ran = await run(bwrap, argv.value, timeoutMs, bwrapFiles(BWRAP_WORKDIR));
		if (ran.timedOut) return no("timeout", `bwrap did not run true in a box within ${timeoutMs} ms and was killed`);
		if (ran.error === undefined && ran.code === 0) return { available: true, bwrap, version };
		if (USERNS_DENIED.test(ran.stderr))
			return no("userns_denied", usernsReason(ran.stderr, options.sysctl ?? sysctl));
		return no("failed", `bwrap could not run true in a box: it ${ended(ran)}: ${said(ran.stderr)}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function usernsReason(stderr: string, read: (name: string) => string | undefined): string {
	const why =
		read("kernel.apparmor_restrict_unprivileged_userns") === "1"
			? "AppArmor restricts unprivileged user namespaces on this host (kernel.apparmor_restrict_unprivileged_userns = 1): bwrap needs an AppArmor profile that grants it userns, which the host's operator loads once"
			: read("kernel.unprivileged_userns_clone") === "0"
				? "this host turns unprivileged user namespaces off (kernel.unprivileged_userns_clone = 0)"
				: read("user.max_user_namespaces") === "0"
					? "this host allows no user namespaces (user.max_user_namespaces = 0)"
					: "this host denies bwrap a user namespace";
	return `${why}; bwrap said: ${said(stderr)}`;
}

function sysctl(name: string): string | undefined {
	try {
		return readFileSync(`/proc/sys/${name.replaceAll(".", "/")}`, "utf8").trim();
	} catch {
		return undefined;
	}
}

/** The first executable regular file `name` in the directories of `path`, or `undefined`. */
function onPath(name: string, path: string): string | undefined {
	for (const directory of path.split(":")) {
		if (!directory.startsWith("/")) continue;
		const candidate = posix.join(directory, name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

const older = (version: readonly number[], floor: readonly number[]): boolean => {
	for (let n = 0; n < floor.length; n++) {
		if (version[n]! !== floor[n]!) return version[n]! < floor[n]!;
	}
	return false;
};

const said = (text: string): string => JSON.stringify(text.trim().slice(0, 300) || "(nothing)");

type Ran = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly error?: Error;
};

const ended = (ran: Ran): string =>
	ran.error !== undefined
		? `could not start (${ran.error.message})`
		: ran.signal !== null
			? `was ended by ${ran.signal}`
			: `exited ${ran.code}`;

/**
 * Runs `file` with `args` in a process group of its own, with an environment of `PATH` alone, writing each of `data` on
 * its descriptor. At `timeoutMs` the group is killed and the run answers without waiting for anything that still holds
 * its output.
 */
function run(
	file: string,
	args: readonly string[],
	timeoutMs: number,
	data: readonly (readonly [number, string])[] = [],
): Promise<Ran> {
	return new Promise((resolve) => {
		const last = Math.max(2, ...data.map(([fd]) => fd));
		const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
		for (let fd = 3; fd <= last; fd++) stdio.push(data.some(([d]) => d === fd) ? "pipe" : "ignore");
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let timer: NodeJS.Timeout | undefined;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: exit?.code ?? null,
				signal: exit?.signal ?? null,
				stdout,
				stderr,
				timedOut,
				...(error ? { error } : {}),
			});
		};
		let child: ChildProcess;
		try {
			child = spawn(file, args, { stdio, env: { PATH: "/usr/bin:/bin" }, detached: true });
		} catch (error) {
			settle(error as Error);
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-4000);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		for (const [fd, text] of data) {
			const pipe = child.stdio[fd] as Writable | null | undefined;
			// bwrap ending before it reads its files resets the pipe: what that means is said by its exit.
			pipe?.on("error", () => {});
			pipe?.end(text);
		}
		child.once("error", (error) => settle(error));
		child.once("exit", (code, signal) => {
			exit = { code, signal };
			if (timedOut) settle();
		});
		child.once("close", () => settle());
		timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// the group is gone
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (exit !== undefined) settle();
			else setTimeout(() => settle(), 1000).unref();
		}, timeoutMs);
	});
}
