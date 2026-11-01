import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxError } from "../src/box/box.ts";
import {
	BWRAP_DATA,
	BWRAP_ETC,
	BWRAP_FLAGS,
	BWRAP_PATH,
	BWRAP_SYSTEM,
	type BwrapHost,
	type BwrapHostFs,
	type BwrapSpec,
	bwrapArgs,
	bwrapFiles,
	checkBwrapArgs,
} from "../src/box/bwrap-args.ts";

// The bwrap box's argv, built and checked. Nothing here runs bwrap: a host's filesystem is either a fake one (a merged-/usr
// host, a split one) or this host's own, read only to resolve paths.

type Entry =
	| { readonly kind: "dir" | "file" | "other" }
	| { readonly kind: "link"; readonly to: string; readonly real?: string };

/** A host whose filesystem is `entries`, links resolved by their `real` (or nowhere). */
function fakeFs(entries: Readonly<Record<string, Entry>>): BwrapHostFs {
	return {
		kind: (path) => entries[path]?.kind ?? null,
		link: (path) => {
			const entry = entries[path];
			if (entry?.kind !== "link") throw new Error(`${path} is not a link`);
			return entry.to;
		},
		real: (path) => {
			const entry = entries[path];
			if (entry === undefined) return undefined;
			return entry.kind === "link" ? entry.real : path;
		},
	};
}

const DIR = { kind: "dir" } as const;
const FILE = { kind: "file" } as const;

/** A merged-/usr host, as most current distributions are, with every part of /etc a box binds, and a workspace at /data/box/ws. */
const MERGED: Readonly<Record<string, Entry>> = {
	"/usr": DIR,
	"/bin": { kind: "link", to: "usr/bin", real: "/usr/bin" },
	"/sbin": { kind: "link", to: "usr/sbin", real: "/usr/sbin" },
	"/lib": { kind: "link", to: "usr/lib", real: "/usr/lib" },
	"/lib64": { kind: "link", to: "usr/lib64", real: "/usr/lib64" },
	"/etc/alternatives": DIR,
	"/etc/ca-certificates": DIR,
	"/etc/ld.so.cache": FILE,
	"/etc/localtime": { kind: "link", to: "/usr/share/zoneinfo/Etc/UTC", real: "/usr/share/zoneinfo/Etc/UTC" },
	"/etc/nsswitch.conf": FILE,
	"/etc/ssl/certs": DIR,
	"/data/box/ws": DIR,
};

const HOME = "/data/home-of-server";
const host = (extra: Partial<BwrapHost> = {}, entries: Readonly<Record<string, Entry>> = MERGED): BwrapHost => ({
	workspace: "/data/box/ws",
	command: ["sh", "-c", "echo hi"],
	homes: [HOME],
	fs: fakeFs(entries),
	...extra,
});

function built(spec: BwrapSpec, h: BwrapHost): string[] {
	const result = bwrapArgs(spec, h);
	if (!result.ok) throw result.error;
	return result.value;
}

function refusal(spec: BwrapSpec, h: BwrapHost): BoxError {
	const result = bwrapArgs(spec, h);
	if (result.ok) throw new Error(`built: ${result.value.join(" ")}`);
	expect(result.error).toBeInstanceOf(BoxError);
	return result.error;
}

/** Each option of an argv with its operands, up to `--`. */
function options(argv: readonly string[]): string[][] {
	const arity: Record<string, number> = {
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
	const out: string[][] = [];
	for (let n = 0; n < argv.length && argv[n] !== "--"; ) {
		const take = arity[argv[n]!] ?? 0;
		out.push(argv.slice(n, n + 1 + take));
		n += 1 + take;
	}
	return out;
}

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
	const root = mkdtempSync(join(tmpdir(), "bwrap-args-"));
	roots.push(root);
	return root;
};

describe("bwrapArgs", () => {
	it("builds every flag, the box's own mounts first, the system read-only, its files, the workspace, a read-only root, the environment and the command, and the argv passes the check", () => {
		const h = host();
		const argv = built({ env: { LANG: "C.UTF-8" } }, h);
		expect(argv.slice(0, BWRAP_FLAGS.length)).toEqual([...BWRAP_FLAGS]);
		expect(options(argv)).toEqual([
			...BWRAP_FLAGS.map((flag) => [flag]),
			["--cap-drop", "ALL"],
			["--hostname", "box"],
			["--proc", "/proc"],
			["--dev", "/dev"],
			["--tmpfs", "/tmp"],
			["--tmpfs", "/dev/shm"],
			["--ro-bind", "/usr", "/usr"],
			["--symlink", "usr/bin", "/bin"],
			["--symlink", "usr/sbin", "/sbin"],
			["--symlink", "usr/lib", "/lib"],
			["--symlink", "usr/lib64", "/lib64"],
			["--ro-bind", "/etc/alternatives", "/etc/alternatives"],
			["--ro-bind", "/etc/ca-certificates", "/etc/ca-certificates"],
			["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"],
			["--ro-bind", "/usr/share/zoneinfo/Etc/UTC", "/etc/localtime"],
			["--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf"],
			["--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"],
			["--ro-bind-data", "3", "/etc/passwd"],
			["--ro-bind-data", "4", "/etc/group"],
			["--ro-bind-data", "5", "/etc/hosts"],
			["--bind", "/data/box/ws", "/workspace"],
			["--remount-ro", "/"],
			["--chdir", "/workspace"],
			["--clearenv"],
			["--setenv", "PATH", BWRAP_PATH],
			["--setenv", "HOME", "/workspace"],
			["--setenv", "LANG", "C.UTF-8"],
		]);
		expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "sh", "-c", "echo hi"]);
		expect(checkBwrapArgs(argv, { env: { LANG: "C.UTF-8" } }, h)).toBeUndefined();
	});

	it("binds a split-/usr host's /bin, /sbin and /lib as directories, read-only, and leaves out what the host lacks", () => {
		const split: Record<string, Entry> = { "/usr": DIR, "/bin": DIR, "/sbin": DIR, "/lib": DIR, "/data/box/ws": DIR };
		const h = host({}, split);
		const argv = built({}, h);
		const binds = options(argv).filter((o) => o[0] === "--ro-bind" || o[0] === "--symlink");
		expect(binds).toEqual([
			["--ro-bind", "/usr", "/usr"],
			["--ro-bind", "/bin", "/bin"],
			["--ro-bind", "/sbin", "/sbin"],
			["--ro-bind", "/lib", "/lib"],
		]);
		expect(checkBwrapArgs(argv, {}, h)).toBeUndefined();
	});

	it("binds no host path but the system, the named part of /etc and the workspace, and only the workspace writable", () => {
		const argv = built({}, host());
		const all = options(argv);
		const allowedDestinations = new Set<string>([...BWRAP_SYSTEM, ...BWRAP_ETC]);
		for (const [option, source, destination] of all.filter((o) => o[0] === "--ro-bind")) {
			expect(allowedDestinations.has(destination!), `${option} ${source} ${destination}`).toBe(true);
			expect(source === destination || source!.startsWith("/usr/") || source!.startsWith("/etc/")).toBe(true);
		}
		expect(all.filter((o) => o[0] === "--bind")).toEqual([["--bind", "/data/box/ws", "/workspace"]]);
		for (const forbidden of ["/", "/etc", "/home", HOME, "/run", "/var", "/root", "/proc", "/sys", "/srv", "/tmp"]) {
			expect(
				all.some((o) => (o[0] === "--bind" || o[0] === "--ro-bind") && o[1] === forbidden),
				forbidden,
			).toBe(false);
		}
		for (const path of ["/etc/passwd", "/etc/group", "/etc/hosts", "/etc/shadow", "/etc/resolv.conf"]) {
			expect(
				all.some((o) => (o[0] === "--bind" || o[0] === "--ro-bind") && o[2] === path),
				path,
			).toBe(false);
		}
		expect(all.filter((o) => o[0] === "--ro-bind-data").map((o) => [Number(o[1]), o[2]])).toEqual(
			BWRAP_DATA.map(([fd, path]) => [fd, path]),
		);
	});

	it("on this host's own filesystem binds only system paths read-only and the workspace as resolved", () => {
		const root = scratch();
		const workspace = join(root, "ws");
		mkdirSync(workspace);
		const h: BwrapHost = { workspace, command: ["true"], homes: [join(root, "home")] };
		const argv = built({ workspace: "/data/box" }, h);
		for (const [option, source, destination] of options(argv)) {
			if (option === "--ro-bind") {
				expect([...BWRAP_SYSTEM, ...BWRAP_ETC]).toContain(destination);
				expect(source === destination || source!.startsWith("/usr/") || source!.startsWith("/etc/")).toBe(true);
			}
			if (option === "--symlink") expect(BWRAP_SYSTEM as readonly string[]).toContain(destination);
		}
		expect(options(argv).filter((o) => o[0] === "--bind")).toEqual([["--bind", workspace, "/data/box"]]);
		expect(checkBwrapArgs(argv, { workspace: "/data/box" }, h)).toBeUndefined();
	});

	it("has no network but its own: absent and none unshare it, open and an allowlist are unsupported", () => {
		for (const network of [undefined, "none"] as const) {
			const argv = built(network === undefined ? {} : { network }, host());
			expect(argv).toContain("--unshare-net");
			expect(argv).not.toContain("--share-net");
		}
		for (const network of ["open", { allow: ["api.example.com"] }] as const) {
			const error = refusal({ network }, host());
			expect(error.code).toBe("unsupported");
			expect(error.message).toMatch(/a bwrap box has no network but its own loopback/);
		}
	});

	it("never inherits this process's environment: --clearenv, then PATH, HOME and the spec's variables alone", () => {
		process.env.PI_TRANSPORT_BWRAP_TEST_SECRET = "inherited-value";
		try {
			const argv = built({ env: { NODE_ENV: "test", PATH: "/opt/tool/bin:/usr/bin" } }, host());
			expect(argv.join("\n")).not.toContain("inherited-value");
			expect(argv.join("\n")).not.toContain("PI_TRANSPORT_BWRAP_TEST_SECRET");
			const env = options(argv).filter((o) => o[0] === "--setenv");
			expect(env).toEqual([
				["--setenv", "PATH", "/opt/tool/bin:/usr/bin"],
				["--setenv", "HOME", "/workspace"],
				["--setenv", "NODE_ENV", "test"],
			]);
			expect(argv.indexOf("--clearenv")).toBeLessThan(argv.indexOf("--setenv"));
		} finally {
			delete process.env.PI_TRANSPORT_BWRAP_TEST_SECRET;
		}
	});

	it("refuses an environment name that is not a variable name, a NUL in a value, and keeps __proto__ a plain name", () => {
		for (const name of ["A=B", "1X", "", "X Y", "X-Y"]) {
			expect(refusal({ env: { [name]: "v" } }, host()).message).toMatch(/is not a variable name/);
		}
		expect(refusal({ env: { X: "a\0b" } }, host()).message).toMatch(/not a string without NUL/);
		const env = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
		const argv = built({ env }, host());
		expect(
			options(argv)
				.filter((o) => o[0] === "--setenv")
				.map((o) => o[1]),
		).toEqual(["PATH", "HOME", "__proto__"]);
	});

	it("refuses a workspace that is relative, has a .. segment, is not in normal form or holds a control character", () => {
		const cases: [string, RegExp][] = [
			["data/box/ws", /is not an absolute path/],
			["./ws", /is not an absolute path/],
			["/data/box/../../etc", /has a \.\. segment/],
			["/data/box/ws/..", /has a \.\. segment/],
			["/data/box//ws", /is not in normal form/],
			["/data/box/./ws", /is not in normal form/],
			["/data/box/ws/", /is not in normal form/],
			["/data/box/w\0s", /holds a control character/],
			["/data/box/w\ns", /holds a control character/],
			["", /is not a path/],
		];
		for (const [workspace, why] of cases) {
			const error = refusal({}, host({ workspace }));
			expect(error.code, workspace).toBe("invalid");
			expect(error.message, workspace).toMatch(why);
		}
	});

	it("refuses a workspace that is a forbidden root, holds one, or lies under one", () => {
		const cases: [string, RegExp][] = [
			["/", /is \/, which a box never sees/],
			["/home", /is \/home/],
			["/var", /is \/var/],
			["/tmp", /is \/tmp/],
			["/srv", /is \/srv, which/],
			["/data", /is \/data/],
			["/etc", /is \/etc/],
			["/etc/ssl", /lies under \/etc/],
			["/proc/1/root", /lies under \/proc/],
			["/sys/fs", /lies under \/sys/],
			["/dev/shm/box", /lies under \/dev/],
			["/run/user/1000/box", /lies under \/run/],
			["/var/run/box", /lies under \/var\/run/],
			["/usr/local/box", /lies under \/usr/],
			["/lib/box", /lies under \/lib/],
			["/root/box", /lies under \/root/],
			["/boot/efi", /lies under \/boot/],
			[HOME, /is \/data\/home-of-server/],
			[`${HOME}/projects/ws`, /lies under \/data\/home-of-server/],
		];
		for (const [workspace, why] of cases) {
			const error = refusal({}, host({ workspace }));
			expect(error.code, workspace).toBe("invalid");
			expect(error.message, workspace).toMatch(why);
		}
		// A sibling whose name merely starts with the home's is not under it.
		const sibling: Record<string, Entry> = { ...MERGED, "/data/home-of-server-other": DIR };
		expect(bwrapArgs({}, host({ workspace: "/data/home-of-server-other" }, sibling)).ok).toBe(true);
	});

	it("refuses a workspace that is, holds or lies under a hidden path, such as the provider's records", () => {
		const entries: Record<string, Entry> = {
			...MERGED,
			"/data/box": DIR,
			"/data/box/records": DIR,
			"/data/box/ws/records": DIR,
		};
		expect(refusal({}, host({ hidden: ["/data/box/ws"] }, entries)).message).toMatch(/is \/data\/box\/ws/);
		expect(refusal({}, host({ hidden: ["/data/box/ws/records"] }, entries)).message).toMatch(
			/holds \/data\/box\/ws\/records/,
		);
		expect(refusal({}, host({ hidden: ["/data/box"] }, entries)).message).toMatch(/lies under \/data\/box/);
		expect(refusal({}, host({ hidden: ["/data/box/"] }, entries)).message).toMatch(/lies under \/data\/box/);
		expect(bwrapArgs({}, host({ hidden: ["/data/box/records"] }, entries)).ok).toBe(true);
		// A path to protect that is not absolute is refused, never passed over.
		expect(refusal({}, host({ hidden: ["data/box/ws"] }, entries)).message).toMatch(
			/a hidden path "data\/box\/ws" is not an absolute path/,
		);
		expect(refusal({}, host({ homes: ["home/server"] }, entries)).message).toMatch(
			/a home "home\/server" is not an absolute path/,
		);
	});

	it("refuses a workspace under this process's own home when no homes are given", () => {
		const error = refusal({}, { workspace: join(homedir(), "box-workspace"), command: ["true"] });
		expect(error.message).toMatch(/lies under/);
	});

	it("checks a workspace as resolved: a link to a forbidden root or into the server's home is refused, a link to an allowed directory binds its target", () => {
		const root = scratch();
		const home = join(root, "home");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		const target = join(root, "real-ws");
		mkdirSync(target);
		symlinkSync("/etc", join(root, "to-etc"));
		symlinkSync(join(home, ".ssh"), join(root, "to-home"));
		symlinkSync(target, join(root, "to-ws"));
		symlinkSync(join(root, "nowhere"), join(root, "dangling"));
		const at = (name: string): BwrapHost => ({ workspace: join(root, name), command: ["true"], homes: [home] });
		expect(refusal({}, at("to-etc")).message).toMatch(/through its links, \/etc is \/etc/);
		expect(refusal({}, at("to-home")).message).toMatch(/through its links, .* lies under .*home/);
		expect(refusal({}, at("dangling")).message).toMatch(/does not exist/);
		expect(refusal({}, at("missing")).message).toMatch(/does not exist/);
		const argv = built({}, at("to-ws"));
		expect(options(argv).filter((o) => o[0] === "--bind")).toEqual([["--bind", target, "/workspace"]]);
		expect(checkBwrapArgs(argv, {}, at("to-ws"))).toBeUndefined();
	});

	it("refuses a workspace that is a file or a socket", async () => {
		const root = scratch();
		writeFileSync(join(root, "file"), "");
		const socket = join(root, "sock");
		const server = createServer();
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		for (const name of ["file", "sock"]) {
			const error = refusal({}, { workspace: join(root, name), command: ["true"], homes: [] });
			expect(error.message, name).toMatch(/is not a directory/);
		}
	});

	it("refuses a box working directory that is relative, the root, /tmp, or in a place the box mounts itself", () => {
		const cases: [string, RegExp][] = [
			["workspace", /is not an absolute path/],
			["/work/../etc", /has a \.\. segment/],
			["/", /may not be \//],
			["/tmp", /may not be \/tmp/],
			["/usr/src/app", /lies in \/usr/],
			["/etc/app", /lies in \/etc/],
			["/proc/self", /lies in \/proc/],
			["/dev/shm", /lies in \/dev/],
			["/bin", /lies in \/bin/],
			["/work:x", /holds a colon/],
			["/work\nroot:x:0:0::/:/bin/sh", /holds a control character/],
		];
		for (const [workspace, why] of cases) expect(refusal({ workspace }, host()).message, workspace).toMatch(why);
		for (const workspace of ["/workspace", "/tmp/work", "/opt/app/work", "/app"]) {
			const h = host();
			const argv = built({ workspace }, h);
			expect(options(argv).find((o) => o[0] === "--chdir")).toEqual(["--chdir", workspace]);
			expect(checkBwrapArgs(argv, { workspace }, h)).toBeUndefined();
		}
	});

	it("refuses an empty command and a command part with a NUL", () => {
		expect(refusal({}, host({ command: [] })).message).toMatch(/the command is empty/);
		expect(refusal({}, host({ command: [""] })).message).toMatch(/the command is empty/);
		expect(refusal({}, host({ command: ["sh", "a\0b"] })).message).toMatch(/NUL/);
	});

	it("refuses a host whose system links out of /usr, or resolves a system directory or a part of /etc elsewhere", () => {
		expect(
			refusal(
				{},
				host(
					{},
					{
						...MERGED,
						"/lib": { kind: "link", to: "/data/home-of-server/lib", real: "/data/home-of-server/lib" },
					},
				),
			).message,
		).toMatch(/this host's \/lib links to \/data\/home-of-server\/lib, outside \/usr/);
		expect(
			refusal({}, host({}, { ...MERGED, "/lib": { kind: "link", to: "usr/../home", real: "/home" } })).message,
		).toMatch(/outside \/usr/);
		expect(
			refusal(
				{},
				host(
					{},
					{
						...MERGED,
						"/etc/nsswitch.conf": { kind: "link", to: "/data/home-of-server/x", real: "/data/home-of-server/x" },
					},
				),
			).message,
		).toMatch(/this host's \/etc\/nsswitch.conf resolves to \/data\/home-of-server\/x, outside \/etc and \/usr/);
		// A link of /etc that leads nowhere (a time zone not installed) is left out.
		const argv = built(
			{},
			host({}, { ...MERGED, "/etc/localtime": { kind: "link", to: "/usr/share/zoneinfo/Nowhere" } }),
		);
		expect(options(argv).some((o) => o[2] === "/etc/localtime")).toBe(false);
	});
});

describe("checkBwrapArgs", () => {
	const spec: BwrapSpec = { env: { LANG: "C.UTF-8" } };
	const argv = () => built(spec, host());
	/** The argv with `extra` inserted just before `--remount-ro /`, the last mount. */
	const insert = (...extra: string[]) => {
		const a = argv();
		const at = a.indexOf("--remount-ro");
		return [...a.slice(0, at), ...extra, ...a.slice(at)];
	};
	const without = (option: string, operands = 0) => {
		const a = argv();
		const at = a.indexOf(option);
		expect(at).toBeGreaterThanOrEqual(0);
		return [...a.slice(0, at), ...a.slice(at + 1 + operands)];
	};
	const refused = (a: readonly string[], why: RegExp) => {
		const error = checkBwrapArgs(a, spec, host());
		expect(error, `not refused: ${a.join(" ")}`).toBeInstanceOf(BoxError);
		expect(error!.code).toBe("invalid");
		expect(error!.message).toMatch(why);
	};

	it("passes the argv bwrapArgs built", () => {
		expect(checkBwrapArgs(argv(), spec, host())).toBeUndefined();
	});

	it("refuses an option a box never uses, each by name", () => {
		for (const extra of [
			["--share-net"],
			["--cap-add", "ALL"],
			["--cap-add", "CAP_SYS_ADMIN"],
			["--dev-bind", "/dev", "/dev"],
			["--bind-try", "/data/home-of-server", "/h"],
			["--ro-bind-try", "/data/home-of-server", "/h"],
			["--unsetenv", "PATH"],
			["--as-pid-1"],
			["--args", "7"],
			["--userns", "7"],
			["--userns2", "7"],
			["--pidns", "7"],
			["--uid", "0"],
			["--gid", "0"],
			["--seccomp", "7"],
			["--add-seccomp-fd", "7"],
			["--info-fd", "7"],
			["--json-status-fd", "7"],
			["--block-fd", "7"],
			["--sync-fd", "7"],
			["--file", "7", "/etc/shadow"],
			["--bind-data", "7", "/x"],
			["--dir", "/x"],
			["--chmod", "0777", "/workspace"],
			["--perms", "0777"],
			["--overlay-src", "/data/home-of-server"],
			["--unshare-all"],
			["--exec-label", "x"],
			["--lock-file", "/x"],
			["--level-prefix"],
			["stray-word"],
		]) {
			refused(
				insert(...extra),
				new RegExp(
					`${JSON.stringify(extra[0]).replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&")} is not an option a bwrap box uses`,
				),
			);
		}
	});

	it("refuses an extra --bind, a second writable bind elsewhere, and a --bind away from the working directory", () => {
		refused(
			insert("--bind", "/data/home-of-server", "/h"),
			/a box has one --bind, its workspace, and this argv has 2/,
		);
		refused(insert("--bind", "/data/box/ws", "/workspace"), /this argv has 2/);
		const moved = argv().map((part, n, a) => (a[n - 2] === "--bind" ? "/elsewhere" : part));
		refused(moved, /--bind \/data\/box\/ws to \/elsewhere is not at the working directory \/workspace/);
		const noBind = without("--bind", 2);
		refused(noBind, /this argv has 0/);
	});

	it("refuses a writable bind of a forbidden root, the server's home or a path not in normal form", () => {
		const swap = (source: string) => argv().map((part, n, a) => (a[n - 1] === "--bind" ? source : part));
		refused(swap("/"), /the workspace \/ is \//);
		refused(swap("/etc"), /the workspace \/etc is \/etc/);
		refused(swap("/data/home-of-server/.ssh"), /lies under \/data\/home-of-server/);
		refused(swap("/run/user/1000"), /lies under \/run/);
		refused(swap("/data/box/ws/../../../data/home-of-server"), /--bind's source .* has a \.\. segment/);
		refused(swap("relative"), /--bind's source .* is not an absolute path/);
	});

	it("refuses a read-only bind of anything but the system and the named part of /etc", () => {
		refused(
			insert("--ro-bind", "/data/home-of-server", "/data/home-of-server"),
			/--ro-bind to \/data\/home-of-server is not the system's/,
		);
		refused(insert("--ro-bind", "/", "/host"), /--ro-bind to \/host is not the system's/);
		refused(insert("--ro-bind", "/etc", "/etc"), /--ro-bind to \/etc is not the system's/);
		refused(insert("--ro-bind", "/etc/shadow", "/etc/shadow"), /not the system's/);
		refused(insert("--ro-bind", "/run", "/run"), /not the system's/);
		refused(insert("--ro-bind", "/var/run/docker.sock", "/var/run/docker.sock"), /not the system's/);
		refused(insert("--ro-bind", "/usr", "/usr"), /--ro-bind to \/usr twice/);
		const swapUsr = argv().map((part, n, a) =>
			a[n - 1] === "--ro-bind" && a[n + 1] === "/usr" ? "/data/home-of-server" : part,
		);
		refused(swapUsr, /--ro-bind \/data\/home-of-server to \/usr binds a host path outside the system/);
		const dotted = argv().map((part, n, a) =>
			a[n - 1] === "--ro-bind" && a[n + 1] === "/usr" ? "/usr/../home" : part,
		);
		refused(dotted, /--ro-bind's source "\/usr\/\.\.\/home" has a \.\. segment/);
		const etcWhole = argv().map((part, n, a) =>
			a[n - 1] === "--ro-bind" && a[n + 1] === "/etc/ssl/certs" ? "/etc" : part,
		);
		refused(etcWhole, /--ro-bind \/etc to \/etc\/ssl\/certs binds a host path outside the system/);
	});

	it("refuses a system link out of /usr, a box file at another path, and a private mount elsewhere", () => {
		const link = argv().map((part, n, a) =>
			a[n - 1] === "--symlink" && a[n + 1] === "/lib" ? "/data/home-of-server/lib" : part,
		);
		refused(link, /--symlink \/data\/home-of-server\/lib \/lib leads outside \/usr/);
		refused(insert("--symlink", "usr/bin", "/workspace/bin"), /--symlink to \/workspace\/bin is not a system link/);
		const passwd = argv().map((part, n, a) =>
			a[n - 2] === "--ro-bind-data" && part === "/etc/passwd" ? "/etc/shadow" : part,
		);
		refused(passwd, /--ro-bind-data 3 \/etc\/shadow is not one of the box's files/);
		refused(insert("--tmpfs", "/home"), /--tmpfs \/home is not one of the box's own mounts/);
		refused(insert("--proc", "/proc2"), /--proc \/proc2 is not one of the box's own mounts/);
		refused(without("--proc", 1), /--proc \/proc is missing or made twice/);
		refused(insert("--tmpfs", "/tmp"), /--tmpfs \/tmp is missing or made twice/);
	});

	it("refuses a private mount after a bind under it, which it would hide", () => {
		const h = host();
		const a = built({ workspace: "/tmp/work" }, h);
		const at = a.indexOf("--tmpfs");
		expect(a.slice(at, at + 2)).toEqual(["--tmpfs", "/tmp"]);
		const moved = [...a.slice(0, at), ...a.slice(at + 2)];
		const remount = moved.indexOf("--remount-ro");
		const late = [...moved.slice(0, remount), "--tmpfs", "/tmp", ...moved.slice(remount)];
		const error = checkBwrapArgs(late, { workspace: "/tmp/work" }, h);
		expect(error?.message).toMatch(/--tmpfs \/tmp comes after --bind to \/tmp\/work, which it would hide/);
	});

	it("refuses an argv without its read-only root, or with the remount before the last mount or of another path", () => {
		refused(without("--remount-ro", 1), /--remount-ro \/ is missing/);
		const a = argv();
		const at = a.indexOf("--remount-ro");
		const early = [...a.slice(0, at), ...a.slice(at + 2)];
		const proc = early.indexOf("--proc");
		refused(
			[...early.slice(0, proc), "--remount-ro", "/", ...early.slice(proc)],
			/--remount-ro \/ is not the last mount/,
		);
		refused(
			a.map((part, n) => (a[n - 1] === "--remount-ro" ? "/usr" : part)),
			/--remount-ro \/usr is not the root/,
		);
	});

	it("refuses an argv with any flag removed or given twice, each by name", () => {
		for (const flag of BWRAP_FLAGS) {
			refused(without(flag), new RegExp(`${flag} is missing`));
			refused(insert(flag), new RegExp(`${flag} twice`));
		}
		refused(without("--cap-drop", 1), /--cap-drop is missing/);
		refused(
			argv().map((part, n, a) => (a[n - 1] === "--cap-drop" ? "CAP_NET_RAW" : part)),
			/--cap-drop CAP_NET_RAW is not ALL/,
		);
		refused(without("--hostname", 1), /--hostname is missing/);
		refused(
			argv().map((part, n, a) => (a[n - 1] === "--hostname" ? "the-host" : part)),
			/--hostname the-host is not the box's own/,
		);
		refused(without("--chdir", 1), /--chdir is missing/);
		refused(insert("--chdir", "/workspace"), /--chdir twice/);
	});

	it("refuses an environment that is not the one built: before --clearenv, without it, a name twice, one more or one changed", () => {
		const a = argv();
		refused(["--setenv", "X", "1", ...a], /--setenv before --clearenv/);
		refused(without("--clearenv"), /--setenv before --clearenv/);
		const dashes = a.indexOf("--");
		refused(
			[...a.slice(0, dashes), "--setenv", "PATH", "/data/home-of-server/bin", ...a.slice(dashes)],
			/--setenv PATH twice/,
		);
		refused(
			[...a.slice(0, dashes), "--setenv", "LD_PRELOAD", "/tmp/x.so", ...a.slice(dashes)],
			/it is not the argv built for this box/,
		);
		refused(
			a.map((part) => (part === "C.UTF-8" ? "C" : part)),
			/it is not the argv built for this box: at \d+ it has "C" where "C.UTF-8" was built/,
		);
		refused(
			[...a.slice(0, dashes), "--setenv", "A=B", "1", ...a.slice(dashes)],
			/--setenv "A=B" is not a variable name/,
		);
	});

	it("refuses an argv with no command after --, an option missing its operands, or another command than the one built", () => {
		const a = argv();
		refused(a.slice(0, a.indexOf("--")), /no command after --/);
		refused(a.slice(0, a.indexOf("--") + 1), /no command after --/);
		refused(["--unshare-user", "--bind", "/data/box/ws"], /--bind is missing its operands/);
		refused([...a.slice(0, a.indexOf("--") + 1), "rm", "-rf", "/workspace"], /it is not the argv built for this box/);
	});

	it("answers a spec it would not build with that refusal", () => {
		const error = checkBwrapArgs(argv(), { ...spec, network: "open" }, host());
		expect(error?.code).toBe("unsupported");
	});
});

describe("bwrapFiles", () => {
	it("names the box's one user, with the working directory as its home, its group, and a hosts file of the loopback and the box", () => {
		const files = bwrapFiles("/workspace", { uid: 1234, gid: 5678 });
		expect(files.map(([fd]) => fd)).toEqual(BWRAP_DATA.map(([fd]) => fd));
		expect(files).toEqual([
			[3, "box:x:1234:5678:box:/workspace:/bin/sh\n"],
			[4, "box:x:5678:\n"],
			[5, "127.0.0.1\tlocalhost\n127.0.1.1\tbox\n::1\tlocalhost ip6-localhost ip6-loopback\n"],
		]);
	});
});
