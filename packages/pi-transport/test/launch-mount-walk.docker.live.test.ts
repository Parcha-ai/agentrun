// V4's walk of the tools user's mounts, with a real find, in a root container (T3c): the mounts are chosen by filesystem type from
// a mount table the test writes (the script's own path to it is replaced in a copy of the script), so a /proc without nosuid, a
// tmpfs or devtmpfs holding a setuid file, and a type nobody named can be had in a container that cannot mount. A find shim at
// /usr/local/bin stands for a find that fails on a vanishing entry, with and without -ignore_readdir_race, and for a permission error.
// Needs a Docker daemon and the network (apt): `npm run test:live:docker`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { finish } from "../src/box/files.ts";
import { LAUNCHER_SCRIPT } from "../src/launch/launcher-script.ts";
import { sh } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const labels = { "pi-transport-live": `launch-mount-walk-${process.pid}-${Date.now()}` };
const IMAGE = `pi-transport-mount-walk-test:${process.pid}`;
const TABLE = "/opt/w/mountinfo";

const DOCKERFILE = [
	"FROM debian:bookworm-slim",
	"RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo libcap2-bin iputils-ping && rm -rf /var/lib/apt/lists/*",
	"RUN useradd -m -s /bin/sh pda",
	'RUN find / -xdev \\( -perm -4000 -o -perm -2000 \\) -type f -exec chmod u-s,g-s {} + ; for p in $(command -v ping) /bin/ping /usr/bin/ping; do [ -e "$p" ] && setcap -r "$p" 2>/dev/null; done; true',
].join("\n");

const FRAME = `PI-TRANSPORT-LAUNCH/1\n\n${Buffer.from("x").toString("base64")}\n`;

/** The script with its mount table at `TABLE` (the literal path it reads, in the old script and the new). */
const SCRIPT = LAUNCHER_SCRIPT.replaceAll("/proc/self/mountinfo", TABLE);

/** One mountinfo line for `point` of `type`, with or without nosuid. */
let counter = 100;
const line = (point: string, type: string, options = "rw,relatime") =>
	`${counter++} 1 0:${counter} / ${point} ${options} - ${type} ${type} rw`;

/** A shim at /usr/local/bin, root-owned, 0755, its body written through a quoted heredoc. */
const shim = (name: string, body: string) =>
	`cat > /usr/local/bin/${name} <<'ZZ_SHIM'\n#!/bin/sh\n${body}\nZZ_SHIM\nchmod 0755 /usr/local/bin/${name}`;

/** A find that fails as one that meets a vanished entry fails (a message and exit 1) on `point`, unless it is told -ignore_readdir_race. */
const VANISHING_FIND = (point: string) =>
	shim(
		"find",
		`race=no; for a in "$@"; do [ "$a" = -ignore_readdir_race ] && race=yes; done\n/usr/bin/find "$@"; rc=$?\ncase "$1" in ${point}) if [ $race = no ]; then echo "find: '${point}/gone': No such file or directory" >&2; exit 1; fi ;; esac\nexit $rc`,
	);

/** A find like busybox's: it does not know -ignore_readdir_race (an error, as for any unknown predicate), and fails on `point`. */
const STRICT_FIND = (point: string) =>
	shim(
		"find",
		`for a in "$@"; do [ "$a" = -ignore_readdir_race ] && { echo "find: unknown predicate '$a'" >&2; exit 1; }; done\n/usr/bin/find "$@"; rc=$?\ncase "$1" in ${point}) echo "find: '${point}/gone': No such file or directory" >&2; exit 1 ;; esac\nexit $rc`,
	);

async function withBox(setup: string, use: (box: Box) => Promise<void>): Promise<void> {
	const box = getOrThrow(await dockerBoxes().create({ maxLifetimeMs: 10 * 60_000, labels, image: IMAGE }, context));
	try {
		const done = await sh(box, setup);
		expect(done.exitCode, `setup failed: ${done.text.slice(0, 300)}`).toBe(0);
		await use(box);
	} finally {
		await box.destroy(context);
	}
}

/** Plant `file` (root's, 4755, a copy of true) in `dir`; the mount table is `lines`. */
const setup = (lines: string[], extra = "") =>
	`mkdir -p /opt/w && printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")} > ${TABLE} && ${extra || "true"}`;
const dirs = (...names: string[]) =>
	names.map((n) => `mkdir -p /opt/w/${n} && chmod 755 /opt/w /opt/w/${n}`).join(" && ");
const plant = (path: string) => `cp /bin/true ${path} && chown root:root ${path} && chmod 4755 ${path}`;

/** A framed start of the script (the tools user pda), as the check's tests run it: its output and exit code. */
async function start(box: Box): Promise<{ exitCode: number; out: string }> {
	const dir = `/tmp/mw-${randomBytes(4).toString("hex")}`;
	getOrThrow(
		await box.upload(
			[
				{ path: `${dir}/launcher.sh`, bytes: new TextEncoder().encode(SCRIPT), mode: 0o700 },
				{
					path: `${dir}/spec.sh`,
					bytes: new TextEncoder().encode(
						"GEN='g1'\nFRAMED=1\nTOOLS='pda'\nISOLATION='none'\nrun_program() {\n  exec sleep 300\n}\n",
					),
					mode: 0o600,
				},
			],
			context,
		),
	);
	expect((await sh(box, `chmod 700 ${dir}`)).exitCode).toBe(0);
	const started = getOrThrow(
		await box.exec(["sh", `${dir}/launcher.sh`, "start", dir], { timeoutMs: 120_000 }, context),
	);
	const done = getOrThrow(await finish(started, new TextEncoder().encode(FRAME)));
	return { exitCode: done.exitCode, out: new TextDecoder().decode(done.stdout) };
}

/** A start that went through: the check said CHECKED and the supervisor began (exit 0). */
const passes = (ran: { exitCode: number; out: string }) => {
	expect(ran.exitCode, ran.out).toBe(0);
	expect(ran.out).not.toMatch(/UNSUPPORTED|REFUSED/);
};
const refused = (ran: { exitCode: number; out: string }, file: string) => {
	expect(ran.exitCode, ran.out).toBe(12);
	expect(ran.out).toMatch(
		new RegExp(
			`^REFUSED the tools user pda can run a setuid or setgid root file: .*${file.replaceAll("/", "\\/")}`,
			"m",
		),
	);
};
const unsupported = (ran: { exitCode: number; out: string }, point: string) => {
	expect(ran.exitCode, ran.out).toBe(10);
	expect(ran.out).toContain(`UNSUPPORTED the check could not walk ${point}`);
};

if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 });
	beforeAll(() => {
		const built = spawnSync("docker", ["build", "-t", IMAGE, "-"], { encoding: "utf8", input: DOCKERFILE });
		if (built.status !== 0) throw new Error(`could not build the test image: ${String(built.stderr).slice(-400)}`);
	}, 600_000);
	afterAll(() => {
		spawnSync("docker", ["rmi", "-f", IMAGE]);
	});

	describe("V4's walk, by filesystem type", () => {
		it("does not walk /proc, /sys or a cgroup2 mount that lacks nosuid: a find that fails there, as on a pid that ends mid-walk, refuses nothing", async () => {
			const failing = shim(
				"find",
				`case "$1" in /proc|/sys|/sys/fs/cgroup) echo "find: '$1/1234': No such file or directory" >&2; exit 1 ;; esac\nexec /usr/bin/find "$@"`,
			);
			await withBox(
				setup(
					[
						line("/proc", "proc"),
						line("/sys", "sysfs"),
						line("/sys/fs/cgroup", "cgroup2"),
						line("/opt/w/clean", "ext4"),
					],
					`${dirs("clean")} && ${failing}`,
				),
				async (box) => passes(await start(box)),
			);
		});

		it("still refuses a setuid root file on a tmpfs, on a devtmpfs and on a type nobody named, each without nosuid", async () => {
			for (const [type, file] of [
				["tmpfs", "/opt/w/t/su"],
				["devtmpfs", "/opt/w/d/su"],
				["zzfs", "/opt/w/z/su"],
			] as const) {
				const name = file.split("/")[3]!;
				await withBox(setup([line(`/opt/w/${name}`, type)], `${dirs(name)} && ${plant(file)}`), async (box) =>
					refused(await start(box), file),
				);
			}
		});

		it("does not walk a mount with nosuid, whatever its type", async () => {
			await withBox(
				setup(
					[line("/opt/w/t", "tmpfs", "rw,nosuid,relatime"), line("/opt/w/clean", "ext4")],
					`${dirs("t", "clean")} && ${plant("/opt/w/t/su")}`,
				),
				async (box) => passes(await start(box)),
			);
		});

		it("chooses by type, not by mount point: an ext4 mounted at /proc is walked", async () => {
			await withBox(
				setup([line("/opt/w/proc", "ext4")], `${dirs("proc")} && ${plant("/opt/w/proc/su")}`),
				async (box) => refused(await start(box), "/opt/w/proc/su"),
			);
		});
	});

	describe("V4's walk, and an entry that vanishes", () => {
		it("with a find that takes -ignore_readdir_race (found by the control running it): a vanish on a walked mount is no error", async () => {
			await withBox(
				setup([line("/opt/w/v", "ext4")], `${dirs("v")} && ${VANISHING_FIND("/opt/w/v")}`),
				async (box) => passes(await start(box)),
			);
		});

		it("with a find that does not (busybox): the same vanish is UNSUPPORTED, the check still runs, and it never reads the message", async () => {
			await withBox(setup([line("/opt/w/v", "ext4")], `${dirs("v")} && ${STRICT_FIND("/opt/w/v")}`), async (box) =>
				unsupported(await start(box), "/opt/w/v"),
			);
			// the same find, with nothing vanishing: the check runs strict and passes
			await withBox(setup([line("/opt/w/ok", "ext4")], `${dirs("ok")} && ${STRICT_FIND("/nowhere")}`), async (box) =>
				passes(await start(box)),
			);
		});

		it("a permission error is UNSUPPORTED on a find that takes the flag and on one that does not", async () => {
			const denied = (flagKnown: boolean) =>
				shim(
					"find",
					`${flagKnown ? "" : `for a in "$@"; do [ "$a" = -ignore_readdir_race ] && { echo "find: unknown predicate '$a'" >&2; exit 1; }; done\n`}/usr/bin/find "$@"; rc=$?\ncase "$1" in /opt/w/p) echo "find: '/opt/w/p/secret': Permission denied" >&2; exit 1 ;; esac\nexit $rc`,
				);
			for (const flagKnown of [true, false])
				await withBox(setup([line("/opt/w/p", "ext4")], `${dirs("p")} && ${denied(flagKnown)}`), async (box) =>
					unsupported(await start(box), "/opt/w/p"),
				);
		});

		it("a real GNU find, with files deleted under it while it walks, gives no misfire", async (task) => {
			const walk =
				"( i=0; while [ $i -lt 6 ]; do /usr/bin/find /opt/w/r -xdev -type f -delete 2>/dev/null; i=$((i+1)); done ) &";
			await withBox(
				setup(
					[line("/opt/w/r", "ext4")],
					`${dirs("r")} && cd /opt/w/r && seq 1 120000 | sed 's/^/f/' | xargs touch`,
				),
				async (box) => {
					// the race must be real: a strict find, with the walk's own predicates (they stat each entry), over a directory being emptied fails at least once
					let provoked = false;
					for (let at = 0; at < 12 && !provoked; at++) {
						await sh(box, "cd /opt/w/r && seq 1 120000 | sed 's/^/f/' | xargs touch");
						const raced = await sh(
							box,
							`${walk} /usr/bin/find /opt/w/r -xdev \\( -perm -4000 -user 0 -o -perm -2000 -group 0 \\) -type f -print >/dev/null 2>/tmp/race.err; echo rc=$?; wait`,
						);
						provoked = /rc=[1-9]/.test(raced.text);
					}
					if (!provoked) return task.skip("the container did not provoke a readdir race in 12 tries");
					// the check itself walks while the directory is emptied under it, five times: none may misfire
					for (let at = 0; at < 5; at++) {
						await sh(box, "cd /opt/w/r && seq 1 120000 | sed 's/^/f/' | xargs touch");
						await sh(box, "nohup sh -c '/usr/bin/find /opt/w/r -xdev -type f -delete' >/dev/null 2>&1 &");
						passes(await start(box));
					}
				},
			);
		});

		it("leaves no container behind", async () => {
			expect(getOrThrow(await dockerBoxes().list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("V4's walk, by filesystem type (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("needs a Docker daemon", () => {});
	});
}
