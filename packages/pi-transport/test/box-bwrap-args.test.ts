import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxError } from "../src/box/box.ts";
import {
	BWRAP_DATA,
	BWRAP_ETC,
	BWRAP_SYSTEM,
	type BwrapHost,
	type BwrapHostFs,
	type BwrapSpec,
	bwrapArgs,
	bwrapFiles,
} from "../src/box/bwrap-args.ts";

// The bwrap box's argv. The golden tests pin it element by element for a few hosts; the rest check what it binds and the
// inputs it refuses. Nothing here runs bwrap: a host's filesystem is a fake one (a merged-/usr host, a split one) or this
// host's own, read only to resolve paths.

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

/** The merged host with a provider's records, a link to them, a file and a home under /usr, and a directory in /etc. */
const GUARDED: Readonly<Record<string, Entry>> = {
	...MERGED,
	"/usr/local/records": DIR,
	"/usr/local/records/inner": DIR,
	"/usr/local/records.json": FILE,
	"/usr/local/home-of-server": DIR,
	"/usr/share/zoneinfo": DIR,
	"/etc/ssl/certs/private": DIR,
	"/data/records-link": { kind: "link", to: "/usr/local/records", real: "/usr/local/records" },
	"/data/usr-link": { kind: "link", to: "/usr", real: "/usr" },
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
		"--perms": 1,
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

/** Every bind's source and destination: what of the host a box can see, and where. */
const bound = (argv: readonly string[]) =>
	options(argv)
		.filter((o) => o[0] === "--bind" || o[0] === "--ro-bind")
		.flatMap((o) => [o[1]!, o[2]!]);

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "bwrap-args-")));
	roots.push(root);
	return root;
};

// The parts every argv starts with, and the box's own files: written out, not taken from the module.
const FLAGS = [
	"--unshare-user",
	"--unshare-pid",
	"--unshare-net",
	"--unshare-ipc",
	"--unshare-uts",
	"--unshare-cgroup",
	"--disable-userns",
	"--die-with-parent",
	"--new-session",
	"--cap-drop",
	"ALL",
	"--hostname",
	"box",
	"--proc",
	"/proc",
	"--dev",
	"/dev",
	"--tmpfs",
	"/tmp",
	"--tmpfs",
	"/dev/shm",
];
const MERGED_SYSTEM = [
	"--ro-bind",
	"/usr",
	"/usr",
	"--symlink",
	"usr/bin",
	"/bin",
	"--symlink",
	"usr/sbin",
	"/sbin",
	"--symlink",
	"usr/lib",
	"/lib",
	"--symlink",
	"usr/lib64",
	"/lib64",
	"--ro-bind",
	"/etc/alternatives",
	"/etc/alternatives",
	"--ro-bind",
	"/etc/ca-certificates",
	"/etc/ca-certificates",
	"--ro-bind",
	"/etc/ld.so.cache",
	"/etc/ld.so.cache",
	"--ro-bind",
	"/usr/share/zoneinfo/Etc/UTC",
	"/etc/localtime",
	"--ro-bind",
	"/etc/nsswitch.conf",
	"/etc/nsswitch.conf",
	"--ro-bind",
	"/etc/ssl/certs",
	"/etc/ssl/certs",
];
const FILES = [
	"--ro-bind-data",
	"3",
	"/etc/passwd",
	"--ro-bind-data",
	"4",
	"/etc/group",
	"--ro-bind-data",
	"5",
	"/etc/hosts",
];

describe("bwrapArgs, golden", () => {
	it("a merged-/usr host with the default spec", () => {
		expect(built({}, host())).toEqual([
			...FLAGS,
			...MERGED_SYSTEM,
			...FILES,
			"--bind",
			"/data/box/ws",
			"/workspace",
			"--remount-ro",
			"/",
			"--chdir",
			"/workspace",
			"--clearenv",
			"--setenv",
			"PATH",
			"/usr/local/bin:/usr/bin:/bin",
			"--setenv",
			"HOME",
			"/workspace",
			"--",
			"sh",
			"-c",
			"echo hi",
		]);
	});

	it("a split-/usr host without the /etc it lacks, a working directory under /tmp and the spec's environment", () => {
		const split: Record<string, Entry> = {
			"/usr": DIR,
			"/bin": DIR,
			"/sbin": DIR,
			"/lib": DIR,
			"/etc/ssl/certs": DIR,
			"/data/box/split-ws": DIR,
		};
		const h = host({ workspace: "/data/box/split-ws", command: ["make", "test"] }, split);
		const spec: BwrapSpec = { workspace: "/tmp/work", env: { LANG: "C.UTF-8", PATH: "/opt/tool/bin:/usr/bin" } };
		expect(built(spec, h)).toEqual([
			...FLAGS,
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/bin",
			"/bin",
			"--ro-bind",
			"/sbin",
			"/sbin",
			"--ro-bind",
			"/lib",
			"/lib",
			"--ro-bind",
			"/etc/ssl/certs",
			"/etc/ssl/certs",
			...FILES,
			"--bind",
			"/data/box/split-ws",
			"/tmp/work",
			"--remount-ro",
			"/",
			"--chdir",
			"/tmp/work",
			"--clearenv",
			"--setenv",
			"PATH",
			"/opt/tool/bin:/usr/bin",
			"--setenv",
			"HOME",
			"/tmp/work",
			"--setenv",
			"LANG",
			"C.UTF-8",
			"--",
			"make",
			"test",
		]);
	});

	it("a home and a hidden path inside /usr, each masked by a read-only tmpfs after the system binds", () => {
		const h = host(
			{ homes: [HOME, "/usr/local/home-of-server"], hidden: ["/usr/local/records"], command: ["true"] },
			GUARDED,
		);
		expect(built({}, h)).toEqual([
			...FLAGS,
			...MERGED_SYSTEM,
			"--perms",
			"555",
			"--tmpfs",
			"/usr/local/home-of-server",
			"--remount-ro",
			"/usr/local/home-of-server",
			"--perms",
			"555",
			"--tmpfs",
			"/usr/local/records",
			"--remount-ro",
			"/usr/local/records",
			...FILES,
			"--bind",
			"/data/box/ws",
			"/workspace",
			"--remount-ro",
			"/",
			"--chdir",
			"/workspace",
			"--clearenv",
			"--setenv",
			"PATH",
			"/usr/local/bin:/usr/bin:/bin",
			"--setenv",
			"HOME",
			"/workspace",
			"--",
			"true",
		]);
	});
});

describe("bwrapArgs, what it binds", () => {
	it("binds no host path but the system, the named part of /etc and the workspace, and only the workspace writable", () => {
		const all = options(built({}, host()));
		const allowedDestinations = new Set<string>([...BWRAP_SYSTEM, ...BWRAP_ETC]);
		for (const [option, source, destination] of all.filter((o) => o[0] === "--ro-bind")) {
			expect(allowedDestinations.has(destination!), `${option} ${source} ${destination}`).toBe(true);
			expect(source === destination || source!.startsWith("/usr/") || source!.startsWith("/etc/")).toBe(true);
		}
		expect(all.filter((o) => o[0] === "--bind")).toEqual([["--bind", "/data/box/ws", "/workspace"]]);
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

	it("never binds /run, /var or the host's /tmp, nor anything that holds them, nor anything under /run, and refuses them as a workspace", () => {
		const root = scratch();
		const workspace = join(root, "ws");
		mkdirSync(workspace);
		const argvs = [
			built({}, host()),
			built({}, host({ hidden: ["/usr/local/records"] }, GUARDED)),
			built({ workspace: "/tmp/work" }, { workspace, command: ["true"], homes: [join(root, "home")] }),
		];
		for (const argv of argvs) {
			for (const path of bound(argv)) {
				for (const kept of ["/run", "/var", "/var/run", "/tmp", "/var/tmp"]) {
					expect(path === kept || kept.startsWith(path === "/" ? "/" : `${path}/`), `${path} shows ${kept}`).toBe(
						false,
					);
				}
				expect(path.startsWith("/run/") || path.startsWith("/var/run/"), path).toBe(false);
			}
		}
		for (const [workspace, why] of [
			["/run", /is \/run/],
			["/run/user/1000", /lies under \/run/],
			["/var/run/box", /lies under \/var\/run/],
			["/var", /is \/var/],
			["/tmp", /is \/tmp/],
			["/var/tmp", /is \/var\/tmp/],
		] as const) {
			expect(refusal({}, host({ workspace })).message, workspace).toMatch(why);
		}
	});

	it("on this host's own filesystem binds only system paths read-only and the workspace", () => {
		const root = scratch();
		const workspace = join(root, "ws");
		mkdirSync(workspace);
		const argv = built({ workspace: "/data/box" }, { workspace, command: ["true"], homes: [join(root, "home")] });
		for (const [option, source, destination] of options(argv)) {
			if (option === "--ro-bind") {
				expect([...BWRAP_SYSTEM, ...BWRAP_ETC]).toContain(destination);
				expect(source === destination || source!.startsWith("/usr/") || source!.startsWith("/etc/")).toBe(true);
			}
			if (option === "--symlink") expect(BWRAP_SYSTEM as readonly string[]).toContain(destination);
		}
		expect(options(argv).filter((o) => o[0] === "--bind")).toEqual([["--bind", workspace, "/data/box"]]);
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
			expect(options(argv).filter((o) => o[0] === "--setenv")).toEqual([
				["--setenv", "PATH", "/opt/tool/bin:/usr/bin"],
				["--setenv", "HOME", "/workspace"],
				["--setenv", "NODE_ENV", "test"],
			]);
			expect(argv.indexOf("--clearenv")).toBeLessThan(argv.indexOf("--setenv"));
		} finally {
			delete process.env.PI_TRANSPORT_BWRAP_TEST_SECRET;
		}
	});
});

describe("bwrapArgs, a protected path inside the system", () => {
	const at = (argv: readonly string[], ...mount: string[]) =>
		options(argv).findIndex((o) => o.length === mount.length && o.every((part, n) => part === mount[n]));
	/** The mask at `path`: `--perms 555 --tmpfs <path> --remount-ro <path>`, in that order, once. */
	const masked = (argv: readonly string[], path: string) => {
		const tmpfs = at(argv, "--tmpfs", path);
		expect(tmpfs, `no mask at ${path}`).toBeGreaterThan(0);
		const all = options(argv);
		expect([all[tmpfs - 1], all[tmpfs], all[tmpfs + 1]]).toEqual([
			["--perms", "555"],
			["--tmpfs", path],
			["--remount-ro", path],
		]);
		expect(all.filter((o) => o[0] === "--tmpfs" && o[1] === path)).toHaveLength(1);
		return tmpfs;
	};

	it("masks a hidden path reached through a link at the place its contents are, and a home under a system directory", () => {
		const linked = built({}, host({ hidden: ["/data/records-link"] }, GUARDED));
		expect(masked(linked, "/usr/local/records")).toBeGreaterThan(at(linked, "--ro-bind", "/usr", "/usr"));
		const home = built({}, host({ homes: [HOME, "/usr/local/home-of-server"] }, GUARDED));
		expect(masked(home, "/usr/local/home-of-server")).toBeGreaterThan(at(home, "--ro-bind", "/usr", "/usr"));
	});

	it("masks only the outermost of nested paths, one inside a split host's /bin, and one inside a bound part of /etc", () => {
		const nested = built({}, host({ hidden: ["/usr/local/records/inner", "/usr/local/records"] }, GUARDED));
		masked(nested, "/usr/local/records");
		expect(at(nested, "--tmpfs", "/usr/local/records/inner")).toBe(-1);
		const split: Record<string, Entry> = { "/usr": DIR, "/bin": DIR, "/bin/secret": DIR, "/data/box/ws": DIR };
		const argv = built({}, host({ hidden: ["/bin/secret"] }, split));
		expect(masked(argv, "/bin/secret")).toBeGreaterThan(at(argv, "--ro-bind", "/bin", "/bin"));
		const etc = built({}, host({ hidden: ["/etc/ssl/certs/private"] }, GUARDED));
		expect(masked(etc, "/etc/ssl/certs/private")).toBeGreaterThan(
			at(etc, "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"),
		);
	});

	it("leaves out a part of /etc whose source lies in a protected path, and masks that path in /usr", () => {
		const argv = built({}, host({ hidden: ["/usr/share/zoneinfo"] }, GUARDED));
		expect(options(argv).some((o) => o[2] === "/etc/localtime")).toBe(false);
		masked(argv, "/usr/share/zoneinfo");
	});

	it("refuses a protected path that is or holds a system root, as named or through a link, and a protected file inside one", () => {
		for (const hidden of ["/usr", "/etc", "/lib", "/data/usr-link"]) {
			const error = refusal({}, host({ hidden: [hidden] }, GUARDED));
			expect(error.message, hidden).toMatch(
				/^the protected path \/\S+ is or holds \/\S+, which a box binds: masking it would leave the box without its system$/,
			);
		}
		expect(refusal({}, host({ homes: ["/usr"] }, GUARDED)).message).toMatch(
			/the protected path \/usr is or holds \/usr/,
		);
		expect(refusal({}, host({ hidden: ["/usr/local/records.json"] }, GUARDED)).message).toMatch(
			/the protected path \/usr\/local\/records\.json is not a directory, and lies in \/usr/,
		);
		// A protected path that does not exist yet has nothing to show: no mask, and the box is built.
		const later = built({}, host({ hidden: ["/usr/local/not-yet"] }, GUARDED));
		expect(options(later).some((o) => o[1] === "/usr/local/not-yet")).toBe(false);
	});
});

describe("bwrapArgs, the inputs it refuses", () => {
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
			["/srv", /is \/srv, which/],
			["/data", /is \/data/],
			["/etc", /is \/etc/],
			["/etc/ssl", /lies under \/etc/],
			["/proc/1/root", /lies under \/proc/],
			["/sys/fs", /lies under \/sys/],
			["/dev/shm/box", /lies under \/dev/],
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

	it("refuses a workspace that is, holds or lies under a hidden path, and a hidden path or home that is not absolute", () => {
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

	it("refuses a workspace with a link in it, whatever it leads to, and one that does not exist", () => {
		const root = scratch();
		const home = join(root, "home");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		const target = join(root, "real-ws");
		mkdirSync(target);
		symlinkSync("/etc", join(root, "to-etc"));
		symlinkSync(join(home, ".ssh"), join(root, "to-home"));
		symlinkSync(target, join(root, "to-ws"));
		symlinkSync(root, join(root, "loop"));
		symlinkSync(join(root, "nowhere"), join(root, "dangling"));
		const at = (path: string): BwrapHost => ({ workspace: path, command: ["true"], homes: [home] });
		expect(refusal({}, at(join(root, "to-etc"))).message).toMatch(
			/has a link in it \(it leads to \/etc\): give its real path/,
		);
		expect(refusal({}, at(join(root, "to-home"))).message).toMatch(/has a link in it \(it leads to .*\.ssh\)/);
		expect(refusal({}, at(join(root, "to-ws"))).message).toMatch(/has a link in it/);
		expect(refusal({}, at(join(root, "loop", "real-ws"))).message).toMatch(/has a link in it/);
		expect(refusal({}, at(join(root, "dangling"))).message).toMatch(/does not exist/);
		expect(refusal({}, at(join(root, "missing"))).message).toMatch(/does not exist/);
		expect(options(built({}, at(target))).filter((o) => o[0] === "--bind")).toEqual([
			["--bind", target, "/workspace"],
		]);
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

	it("refuses a box working directory that is relative, the root, /tmp, in a place the box mounts itself, or holds a colon", () => {
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
			expect(options(built({ workspace }, host())).find((o) => o[0] === "--chdir")).toEqual(["--chdir", workspace]);
		}
	});

	it("refuses an empty command and a command part with a NUL", () => {
		expect(refusal({}, host({ command: [] })).message).toMatch(/the command is empty/);
		expect(refusal({}, host({ command: [""] })).message).toMatch(/the command is empty/);
		expect(refusal({}, host({ command: ["sh", "a\0b"] })).message).toMatch(/NUL/);
	});

	it("refuses a host whose system links out of /usr, or resolves a part of /etc elsewhere, and leaves out a dangling one", () => {
		const outOfUsr = {
			...MERGED,
			"/lib": { kind: "link", to: "/data/home-of-server/lib", real: "/data/home-of-server/lib" },
		} as const;
		expect(refusal({}, host({}, outOfUsr)).message).toMatch(
			/this host's \/lib links to \/data\/home-of-server\/lib, outside \/usr/,
		);
		expect(
			refusal({}, host({}, { ...MERGED, "/lib": { kind: "link", to: "usr/../home", real: "/home" } })).message,
		).toMatch(/outside \/usr/);
		const etcOut = {
			...MERGED,
			"/etc/nsswitch.conf": { kind: "link", to: "/data/home-of-server/x", real: "/data/home-of-server/x" },
		} as const;
		expect(refusal({}, host({}, etcOut)).message).toMatch(
			/this host's \/etc\/nsswitch.conf resolves to \/data\/home-of-server\/x, outside \/etc and \/usr/,
		);
		const argv = built(
			{},
			host({}, { ...MERGED, "/etc/localtime": { kind: "link", to: "/usr/share/zoneinfo/Nowhere" } }),
		);
		expect(options(argv).some((o) => o[2] === "/etc/localtime")).toBe(false);
	});
});

describe("bwrapFiles", () => {
	it("names the box's one user with the working directory as its home, nobody for unmapped ids, and a hosts file of the loopback and the box", () => {
		expect(bwrapFiles("/workspace", { uid: 1234, gid: 5678 })).toEqual([
			[3, "box:x:1234:5678:box:/workspace:/bin/sh\nnobody:x:65534:65534:nobody:/:/usr/sbin/nologin\n"],
			[4, "box:x:5678:\nnogroup:x:65534:\n"],
			[5, "127.0.0.1\tlocalhost\n127.0.1.1\tbox\n::1\tlocalhost ip6-localhost ip6-loopback\n"],
		]);
		expect(bwrapFiles("/workspace", { uid: 65534, gid: 65534 }).slice(0, 2)).toEqual([
			[3, "box:x:65534:65534:box:/workspace:/bin/sh\n"],
			[4, "box:x:65534:\n"],
		]);
		expect(bwrapFiles("/w", { uid: 1, gid: 1 }).map(([fd]) => fd)).toEqual(BWRAP_DATA.map(([fd]) => fd));
	});
});
