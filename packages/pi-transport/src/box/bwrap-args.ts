/**
 * The bwrap box's arguments: the argv that runs one command of a box under bubblewrap on Linux, built in one place from
 * fixed lists with every variable input checked, and the probe that says whether this host can run such a box and,
 * when it cannot, why.
 *
 * A bwrap box is a directory on this host, its workspace. Each `exec` runs `bwrap <these arguments> -- <command>` in new
 * user, pid, mount, network, IPC, UTS and cgroup namespaces, where the program has:
 * - the workspace, bound read-write at the box's working directory: the one host directory it can write;
 * - the system read-only (`/usr`, the `/bin`, `/sbin` and `/lib*` beside it or linked into it, and a named part of
 *   `/etc`), a private `/proc`, `/dev` and `/tmp`, and the root itself remounted read-only;
 * - its own `/etc/passwd`, `/etc/group` and `/etc/hosts`, which the spawner writes on fixed descriptors (`bwrapFiles`);
 * - nothing else of the host: no home, no data root, no `/run`, no `/var`, not the host's `/tmp`, no socket. A home or
 *   a hidden path inside a bound system directory is masked there by an empty tmpfs, itself remounted read-only;
 * - no network but a loopback of its own (`--unshare-net`). `open` would share this host's network namespace, its
 *   loopback services and abstract sockets included, so it is refused, and so is an allowlist;
 * - no capability (`--cap-drop ALL`), no further user namespace (`--disable-userns`), a session of its own, a hostname
 *   of its own, and death with the process that spawned bwrap (`--die-with-parent`);
 * - an environment made from the spec alone (`--clearenv`, then `--setenv` pairs), never this process's.
 *
 * No seccomp filter: with no runtime or temporary directory of the host bound and a network namespace of its own, the
 * box has no host socket to reach, and `--disable-userns` closes the nested-namespace route.
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

/** The flags every box carries, each once. No `-try` form: a namespace this host cannot make fails the box. */
export const BWRAP_FLAGS = [
	"--unshare-user",
	"--unshare-pid",
	"--unshare-net",
	"--unshare-ipc",
	"--unshare-uts",
	"--unshare-cgroup",
	"--disable-userns",
	"--die-with-parent",
	"--new-session",
] as const;

/** The id a user namespace shows for every host id it does not map. */
const NOBODY = 65534;

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
	/** The host directory that is the box's workspace: absolute, in normal form, no link in it, an existing directory. */
	readonly workspace: string;
	/** The program and its arguments, run without a shell. */
	readonly command: readonly string[];
	/**
	 * Host paths no box may see, such as the provider's own records: a workspace that is one, holds one or lies under
	 * one is refused, and one inside a bound system directory is masked.
	 */
	readonly hidden?: readonly string[];
	/** The server's home directories; default this process's `HOME` and its user's home. Treated as hidden paths. */
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

/**
 * The paths a box never sees: the server's homes and the caller's hidden paths, each as named and, when it exists, as
 * resolved through its links, so that both are protected. `invalid` for one that is not absolute: passing it over would
 * show what it names.
 */
type Guarded = { readonly named: readonly string[]; readonly resolved: readonly string[] };

function guardedPaths(host: BwrapHost, fs: BwrapHostFs): Guarded | BoxError {
	// A home of `/` (a service user's) protects nothing a root of its own would not: `/` is never bound whole.
	const homes = (host.homes ?? defaultHomes()).filter((home) => home !== "/");
	const given = [
		...homes.map((path) => ["a home", path] as const),
		...(host.hidden ?? []).map((path) => ["a hidden path", path] as const),
	];
	const named = new Set<string>();
	const resolved = new Set<string>();
	for (const [what, path] of given) {
		if (typeof path !== "string" || !path.startsWith("/")) {
			return invalid(`${what} ${JSON.stringify(path)} is not an absolute path`);
		}
		const name = posix.resolve(path);
		named.add(name);
		const real = fs.real(name);
		if (real !== undefined) resolved.add(real);
	}
	return { named: [...named], resolved: [...resolved] };
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
function placeRefusal(path: string, guarded: Guarded, what: string): BoxError | undefined {
	const under = [...NEVER_UNDER, ...guarded.named, ...guarded.resolved];
	const all = [...under, ...NEVER_HOLDS];
	const exact = all.find((root) => path === root);
	if (exact !== undefined) return invalid(`${what} ${path} is ${exact}, which a box never sees`);
	const held = all.find((root) => isUnder(root, path));
	if (held !== undefined) return invalid(`${what} ${path} holds ${held}, which a box never sees`);
	const above = under.find((root) => isUnder(path, root));
	if (above !== undefined) return invalid(`${what} ${path} lies under ${above}, which a box never sees`);
	return undefined;
}

/** The host directory bound as the workspace: its own real path, an existing directory in no forbidden place. */
function workspaceSource(host: BwrapHost, fs: BwrapHostFs, guarded: Guarded): string | BoxError {
	const path = host.workspace;
	const shape = shapeRefusal(path, "the workspace");
	if (shape !== undefined) return shape;
	const place = placeRefusal(path, guarded, "the workspace");
	if (place !== undefined) return place;
	const real = fs.real(path);
	if (real === undefined) return invalid(`the workspace ${path} does not exist`);
	// A link would bind what it leads to, which the checks above never saw: the caller gives the real path.
	if (real !== path)
		return invalid(`the workspace ${path} has a link in it (it leads to ${real}): give its real path`);
	if (fs.kind(path) !== "dir") return invalid(`the workspace ${path} is not a directory`);
	return path;
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

/**
 * The read-only system: a directory bound as resolved, or a merged-`/usr` link made again in the box; then the part of
 * `/etc`; then a mask over every guarded directory those binds would show.
 *
 * A guarded path that is or holds a system root or `/etc` is refused: masking it would leave the box without its
 * system. A part of `/etc` that is, or lies in, a guarded path is left out. A guarded directory inside a bound directory
 * is masked at its place in the box, after the bind, by an empty tmpfs of mode 555 remounted read-only on its own (the
 * final `--remount-ro /` reaches only the root's own mount). Its resolved form is the one masked: a named path with a
 * link in it reaches its contents only through that form, and a path that does not exist has nothing to show (each
 * exec's arguments are built again, and mask it once it does). A guarded file there is refused: a tmpfs masks only a
 * directory.
 */
function systemMounts(fs: BwrapHostFs, guarded: Guarded): string[][] | BoxError {
	const protectedPaths = [...guarded.named, ...guarded.resolved];
	for (const root of [...BWRAP_SYSTEM, "/etc"]) {
		// A root that is a link is made again in the box, never bound: only a directory's resolved source is bound.
		const real = fs.kind(root) === "dir" ? fs.real(root) : undefined;
		const hit = protectedPaths.find((path) => isUnder(root, path) || (real !== undefined && isUnder(real, path)));
		if (hit !== undefined) {
			return invalid(
				`the protected path ${hit} is or holds ${root}, which a box binds: masking it would leave the box without its system`,
			);
		}
	}
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
		if (protectedPaths.some((guard) => isUnder(real, guard) || isUnder(path, guard))) continue;
		mounts.push(["--ro-bind", real, path]);
	}
	const masks: string[] = [];
	for (const [option, source, destination] of mounts) {
		if (option !== "--ro-bind" || fs.kind(source!) !== "dir") continue;
		for (const path of guarded.resolved) {
			if (path === source || !isUnder(path, source!)) continue;
			if (fs.kind(path) !== "dir") {
				return invalid(
					`the protected path ${path} is not a directory, and lies in ${destination}, which a box binds: a box masks only a directory there, so protect the directory that holds it`,
				);
			}
			masks.push(posix.join(destination!, path.slice(source!.length)));
		}
	}
	// The outermost masks only: one hides everything under it.
	const outermost = [...new Set(masks)].filter(
		(mask, _, all) => !all.some((other) => other !== mask && isUnder(mask, other)),
	);
	return [
		...mounts,
		...outermost.flatMap((mask) => [
			["--perms", "555"],
			["--tmpfs", mask],
			["--remount-ro", mask],
		]),
	];
}

/**
 * The whole argv of `bwrap` for one command of a box, its own path not included: the flags, the box's own mounts, the
 * system read-only with every guarded directory in it masked, the files on descriptors, the workspace, the root
 * remounted read-only, the working directory, the environment, `--` and the command. Every argv a box runs comes from
 * here, and its tests pin it element by element.
 *
 * `unsupported` for a network other than `none` (absent means `none`); `invalid` for a workspace, a hidden path, a
 * home, a working directory, an environment or a command it will not build. Nothing is spawned.
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
	const guarded = guardedPaths(host, fs);
	if (guarded instanceof BoxError) return err(guarded);
	const source = workspaceSource(host, fs, guarded);
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
	const system = systemMounts(fs, guarded);
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
 * user (this host's uid and gid, which bwrap keeps), with the working directory as its home, and `nobody` (65534), which
 * every host id the box does not map shows as; and a hosts file that names only the loopback and the box's hostname.
 */
export function bwrapFiles(
	workdir: string,
	ids: { readonly uid: number; readonly gid: number } = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
): readonly (readonly [fd: number, text: string])[] {
	const nobody = ids.uid === NOBODY ? "" : `nobody:x:${NOBODY}:${NOBODY}:nobody:/:/usr/sbin/nologin\n`;
	const nogroup = ids.gid === NOBODY ? "" : `nogroup:x:${NOBODY}:\n`;
	return [
		[3, `box:x:${ids.uid}:${ids.gid}:box:${workdir}:/bin/sh\n${nobody}`],
		[4, `box:x:${ids.gid}:\n${nogroup}`],
		[5, `127.0.0.1\tlocalhost\n127.0.1.1\t${BWRAP_HOSTNAME}\n::1\tlocalhost ip6-localhost ip6-loopback\n`], // key-gate: loopback-rule the generated /etc/hosts of the box names only its loopback
	];
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
	/** This process runs as root without `CAP_SETFCAP`, which bwrap needs to map root into a user namespace. */
	| "setfcap"
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
	/** The `bwrap` to probe, an absolute path. Default: the first executable `bwrap` in an absolute directory of `path`. */
	readonly bwrap?: string;
	/** The `PATH` searched for `bwrap`. Default this process's `PATH`; a relative entry, the current directory, is skipped. */
	readonly path?: string;
	/** How long each of the probe's two runs may take before it is killed. Default 5000 ms. */
	readonly timeoutMs?: number;
	/** Where the probe makes its box's workspace, which it removes. Default the OS's temporary directory. */
	readonly scratch?: string;
	/** For tests: the platform (default this process's). */
	readonly platform?: NodeJS.Platform;
	/** For tests: a sysctl's value, such as `kernel.apparmor_restrict_unprivileged_userns`, or `undefined` (default: read from `/proc/sys`). */
	readonly sysctl?: (name: string) => string | undefined;
	/** For tests: this process's uid and effective capabilities (default: its own, from `/proc/self/status`). */
	readonly self?: () => { readonly uid: number; readonly capabilities?: bigint };
};

/** What bwrap says when the host denies it a user namespace, or the powers it needs in one. */
const USERNS_DENIED =
	/setting up [ug]id map: Permission denied|No permissions to creat(?:e|ing) new namespace|unprivileged user namespaces|Creating new namespace failed: Operation not permitted|loopback: Failed RTM_NEWADDR: Operation not permitted/i;

/** `CAP_SETFCAP`'s bit in a capability set. */
const CAP_SETFCAP = 31n;

/**
 * Whether this host can run a bwrap box, by reading and running bwrap, never by changing anything: the platform, an
 * executable `bwrap` that is not setuid, a caller that is not root without `CAP_SETFCAP`, `bwrap --version` at
 * `BWRAP_MIN_VERSION` or later, and one box built by `bwrapArgs` exactly as an exec's is, running `true`. Each run is
 * bounded by `timeoutMs` and killed with its process group at the bound. What bwrap says when that box fails is matched
 * against the known denials; a host that denies bwrap a user namespace is `userns_denied`, naming the setting that
 * denies it where `/proc/sys` has one, and the fix is left to the host's administrator.
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
	const caller = (options.self ?? self)();
	if (caller.uid === 0 && caller.capabilities !== undefined && ((caller.capabilities >> CAP_SETFCAP) & 1n) === 0n) {
		return no(
			"setfcap",
			"this process runs as root without CAP_SETFCAP, which bwrap needs to map root into the box's user namespace: grant it the capability, or run it as a user that is not root",
		);
	}
	const timeoutMs = options.timeoutMs ?? 5000;
	const asked = await run(bwrap, ["--version"], timeoutMs);
	if (asked.timedOut) return no("timeout", `${bwrap} --version did not answer within ${timeoutMs} ms and was killed`);
	if (asked.error !== undefined || asked.code !== 0) {
		return no("failed", `${bwrap} --version ${ended(asked)}: ${said(asked.stderr || asked.stdout)}`);
	}
	const named = /^bubblewrap (\d+)\.(\d+)\.(\d+)/m.exec(asked.stdout);
	if (named === null) {
		return no("version", `${bwrap} --version said ${said(asked.stdout)}, which names no bubblewrap version`);
	}
	const version = named.slice(1, 4).join(".");
	if (older(named.slice(1, 4).map(Number), BWRAP_MIN_VERSION.split(".").map(Number))) {
		return no(
			"version",
			`bwrap ${version} is older than ${BWRAP_MIN_VERSION}, the first with --disable-userns, which every box carries`,
		);
	}
	let scratch: string;
	try {
		// Its real path: a box's workspace has no link in it.
		scratch = realpathSync(mkdtempSync(posix.join(options.scratch ?? tmpdir(), "bwrap-probe-")));
	} catch (error) {
		return no("failed", `the probe could not make its box's workspace: ${(error as Error).message}`);
	}
	try {
		const argv = bwrapArgs({}, { workspace: scratch, command: ["true"] });
		if (!argv.ok) return no("failed", `the probe's own box is refused: ${argv.error.message}`);
		const ran = await run(bwrap, argv.value, timeoutMs, bwrapFiles(BWRAP_WORKDIR));
		if (ran.timedOut) return no("timeout", `bwrap did not run true in a box within ${timeoutMs} ms and was killed`);
		if (ran.error === undefined && ran.code === 0) return { available: true, bwrap, version };
		if (USERNS_DENIED.test(ran.stderr)) {
			return no("userns_denied", usernsReason(ran.stderr, options.sysctl ?? sysctl));
		}
		return no("failed", `bwrap could not run true in a box: it ${ended(ran)}: ${said(ran.stderr)}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function usernsReason(stderr: string, read: (name: string) => string | undefined): string {
	const why =
		read("kernel.apparmor_restrict_unprivileged_userns") === "1"
			? "AppArmor restricts unprivileged user namespaces on this host (kernel.apparmor_restrict_unprivileged_userns = 1): the host's administrator either loads an AppArmor profile that grants bwrap userns or turns the restriction off"
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

/** This process's uid and effective capabilities (`CapEff` of `/proc/self/status`), the latter when it can be read. */
function self(): { uid: number; capabilities?: bigint } {
	const uid = process.getuid?.() ?? -1;
	try {
		const hex = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
		return hex === undefined ? { uid } : { uid, capabilities: BigInt(`0x${hex}`) };
	} catch {
		return { uid };
	}
}

/** The first executable regular file `name` in the absolute directories of `path`, or `undefined`. */
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
