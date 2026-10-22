// The tools user's check fails CLOSED (T3, `toolsUser`): the launcher runs it in a bounded process of its own, and it answers only
// when its tools answer for a probe planted to be found. A check that is killed, a find or a getcap that is silent, a find that
// fails on a mount, a switch to the tools user that never runs, and a check past its bound each leave the launch unsupported,
// never accepted; the probe is gone afterwards either way. The cases run the launcher's script directly in a root container, from
// a spec the test writes, so the bound can be shortened through the script-text seam (TOOLS_CHECK_LINE) as PTRACE_FILE_LINE is.
// Needs a Docker daemon and the network (apt): `npm run test:live:docker`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { finish } from "../src/box/files.ts";
import { LAUNCHER_SCRIPT, PTRACE_FILE_LINE, TOOLS_CHECK_LINE } from "../src/launch/launcher-script.ts";
import { sh, until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const labels = { "pi-transport-live": `launch-tools-check-${process.pid}-${Date.now()}` };
const IMAGE = `pi-transport-tools-check-test:${process.pid}`;

// The tools-user image: Debian with sudo, libcap2-bin and ping, every setuid and setgid bit stripped, no capability left, a user pda.
const DOCKERFILE = [
	"FROM debian:bookworm-slim",
	"RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo libcap2-bin iputils-ping && rm -rf /var/lib/apt/lists/*",
	"RUN useradd -m -s /bin/sh pda",
	'RUN find / -xdev \\( -perm -4000 -o -perm -2000 \\) -type f -exec chmod u-s,g-s {} + ; for p in $(command -v ping) /bin/ping /usr/bin/ping; do [ -e "$p" ] && setcap -r "$p" 2>/dev/null; done; true',
].join("\n");

/** A shim at /usr/local/bin (ahead of the real tool on PATH), root-owned, 0755: its body written through a quoted heredoc, unexpanded. */
const shim = (name: string, body: string) =>
	`cat > /usr/local/bin/${name} <<'ZZ_SHIM'\n#!/bin/sh\n${body}\nZZ_SHIM\nchmod 0755 /usr/local/bin/${name}`;

const FRAME = `PI-TRANSPORT-LAUNCH/1\n\n${Buffer.from("x").toString("base64")}\n`;

async function withBox(setup: string | undefined, use: (box: Box) => Promise<void>): Promise<void> {
	const box = getOrThrow(await dockerBoxes().create({ maxLifetimeMs: 10 * 60_000, labels, image: IMAGE }, context));
	try {
		if (setup !== undefined) {
			const done = await sh(box, setup);
			expect(done.exitCode, `setup failed: ${done.text.slice(0, 300)}`).toBe(0);
		}
		await use(box);
	} finally {
		await box.destroy(context);
	}
}

/** A framed start of the launcher's script (or a test copy of it) as root, for a program whose tools user is pda. */
async function start(
	box: Box,
	options: { script?: string; spec?: string; dirMode?: string; before?: (dir: string) => string } = {},
): Promise<{ exitCode: number; out: string; dir: string; ms: number }> {
	const dir = `/tmp/tc-${randomBytes(4).toString("hex")}`;
	const spec =
		options.spec ?? "GEN='g1'\nFRAMED=1\nTOOLS='pda'\nISOLATION='none'\nrun_program() {\n  exec sleep 300\n}\n";
	getOrThrow(
		await box.upload(
			[
				{
					path: `${dir}/launcher.sh`,
					bytes: new TextEncoder().encode(options.script ?? LAUNCHER_SCRIPT),
					mode: 0o700,
				},
				{ path: `${dir}/spec.sh`, bytes: new TextEncoder().encode(spec), mode: 0o600 },
			],
			context,
		),
	);
	// The launch directory is root's alone, as a real launch's is: the probe sits there, out of the tools user's reach.
	expect(
		(await sh(box, `chmod ${options.dirMode ?? "700"} ${dir}${options.before ? ` && ${options.before(dir)}` : ""}`))
			.exitCode,
	).toBe(0);
	const began = Date.now();
	const started = getOrThrow(
		await box.exec(["sh", `${dir}/launcher.sh`, "start", dir], { timeoutMs: 120_000 }, context),
	);
	const done = getOrThrow(await finish(started, new TextEncoder().encode(FRAME)));
	return { exitCode: done.exitCode, out: new TextDecoder().decode(done.stdout), dir, ms: Date.now() - began };
}

/** Whether a path exists in the box. */
async function exists(box: Box, path: string): Promise<boolean> {
	return (await sh(box, `[ -e ${path} ] && echo yes || echo no`)).text.trim() === "yes";
}

if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 });
	beforeAll(() => {
		const built = spawnSync("docker", ["build", "-t", IMAGE, "-"], { encoding: "utf8", input: DOCKERFILE });
		if (built.status !== 0) throw new Error(`could not build the test image: ${String(built.stderr).slice(-400)}`);
	}, 600_000);
	afterAll(() => {
		spawnSync("docker", ["rmi", "-f", IMAGE]);
	});

	describe("the tools user's check fails closed", () => {
		it("passes a clean box: the launch starts, and its probe is not counted and is gone", async () => {
			await withBox(undefined, async (box) => {
				const ran = await start(box);
				expect(ran.exitCode, ran.out).toBe(0);
				await until("the supervisor", async () =>
					(await exists(box, `${ran.dir}/launcher.pid`)) ? true : undefined,
				);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
			});
		});

		it("refuses a planted setuid root file by its name, never its own probe, and the probe is gone", async () => {
			await withBox(
				"cp /bin/true /usr/local/bin/rootbin && chown root:root /usr/local/bin/rootbin && chmod 4755 /usr/local/bin/rootbin",
				async (box) => {
					const ran = await start(box);
					expect(ran.exitCode).toBe(12);
					expect(ran.out).toMatch(
						/^REFUSED the tools user pda can run a setuid or setgid root file: \/usr\/local\/bin\/rootbin $/m,
					);
					expect(ran.out).not.toContain("tools.probe");
					expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
					expect(await exists(box, `${ran.dir}/launcher.pid`)).toBe(false);
				},
			);
		});

		it("skips no file by its name: a setuid root file named as the probe, where the tools user can run it, is refused", async () => {
			await withBox(
				"cp /bin/true /usr/local/bin/tools.probe && chown root:root /usr/local/bin/tools.probe && chmod 4755 /usr/local/bin/tools.probe",
				async (box) => {
					const ran = await start(box);
					expect(ran.exitCode).toBe(12);
					expect(ran.out).toMatch(
						/^REFUSED the tools user pda can run a setuid or setgid root file: \/usr\/local\/bin\/tools\.probe /m,
					);
				},
			);
		});

		it("skips no file by its directory: a setuid root file in the probe's own directory, opened to the tools user here (0755), is refused", async () => {
			await withBox(undefined, async (box) => {
				const ran = await start(box, {
					dirMode: "755",
					before: (dir) =>
						`cp /bin/true ${dir}/zz-setuid && chown root:root ${dir}/zz-setuid && chmod 4755 ${dir}/zz-setuid`,
				});
				expect(ran.exitCode).toBe(12);
				expect(ran.out).toMatch(
					new RegExp(
						`^REFUSED the tools user pda can run a setuid or setgid root file: ${ran.dir}/zz-setuid `,
						"m",
					),
				);
			});
		});

		it("removes a probe a crashed check left, before its own walk: the launch passes, and the leftover is gone", async () => {
			await withBox(undefined, async (box) => {
				const ran = await start(box, {
					before: (dir) =>
						`: > ${dir}/tools.probe && chmod 4700 ${dir}/tools.probe && setcap cap_net_raw+ep ${dir}/tools.probe`,
				});
				expect(ran.exitCode, ran.out).toBe(0);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
			});
		});

		it("gives a check that is killed (no answer) unsupported, never accepted", async () => {
			// The shim ends the check's whole process group (its own session): the check dies before it answers.
			await withBox(shim("find", "kill -KILL 0"), async (box) => {
				const ran = await start(box);
				expect(ran.exitCode).toBe(10);
				expect(ran.out).toMatch(/^UNSUPPORTED the check of the tools user pda ended without an answer/m);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
				expect(await exists(box, `${ran.dir}/launcher.pid`)).toBe(false);
			});
		});

		it("gives a silent find unsupported: it must find the planted probe", async () => {
			await withBox(shim("find", "exit 0"), async (box) => {
				const ran = await start(box);
				expect(ran.exitCode).toBe(10);
				expect(ran.out).toMatch(/^UNSUPPORTED this box's find does not find a planted setuid root file/m);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
			});
		});

		it("gives a silent getcap unsupported: it must report the probe's planted capability", async () => {
			await withBox(shim("getcap", "exit 0"), async (box) => {
				const ran = await start(box);
				expect(ran.exitCode).toBe(10);
				expect(ran.out).toMatch(/^UNSUPPORTED this box's getcap does not report a planted file capability/m);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
			});
		});

		it("gives a find that fails on a mount unsupported, naming the mount and its error", async () => {
			// It answers for the probe, as the real find, and fails on every walk of a mount.
			const body =
				'case "$1" in */tools.probe) exec /usr/bin/find "$@" ;; esac; echo "find: zz-walk-failed" >&2; exit 1';
			await withBox(shim("find", body), async (box) => {
				const ran = await start(box);
				expect(ran.exitCode).toBe(10);
				expect(ran.out).toMatch(/^UNSUPPORTED the check could not walk \S+: find: zz-walk-failed/m);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
			});
		});

		it("gives a switch to the tools user that never runs the test unsupported: a file it cannot test is not a file it cannot run", async () => {
			// setpriv answers the launcher's probe (-- true) and fails at everything else.
			const body = 'case "$*" in *" -- true") exit 0 ;; esac; exit 1';
			await withBox(
				`${shim("setpriv", body)} && cp /bin/true /usr/local/bin/rootbin && chmod 4755 /usr/local/bin/rootbin`,
				async (box) => {
					const ran = await start(box);
					expect(ran.exitCode).toBe(10);
					expect(ran.out).toMatch(/^UNSUPPORTED this box cannot test a file as the tools user pda/m);
				},
			);
		});

		it("gives a check past its bound unsupported in time, not a hang (the bound shortened to 3 s through the script-text seam)", async () => {
			expect(LAUNCHER_SCRIPT).toContain(TOOLS_CHECK_LINE);
			const script = LAUNCHER_SCRIPT.replace(TOOLS_CHECK_LINE, "TOOLS_CHECK_CENTIS=300");
			await withBox(shim("getcap", "exec sleep 3600"), async (box) => {
				const ran = await start(box, { script });
				expect(ran.exitCode).toBe(10);
				expect(ran.out).toMatch(/^UNSUPPORTED the check of the tools user pda did not finish in 3 s/m);
				expect(ran.ms).toBeLessThan(30_000);
				expect(await exists(box, `${ran.dir}/tools.probe`)).toBe(false);
				const sleeping = await sh(
					box,
					"for p in /proc/[0-9]*; do tr '\\000' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^sleep 3600'",
				);
				expect(sleeping.text.trim()).toBe("0");
			});
		}, 60_000);

		it("leaves nothing the tools user can reach or run when the check dies between planting its probe and removing it", async () => {
			await withBox(shim("find", "kill -KILL 0"), async (box) => {
				const dir = `/tmp/tc-crash-${randomBytes(4).toString("hex")}`;
				const prepared = await sh(
					box,
					`mkdir -m 700 ${dir} && printf 'GEN=g1\\nTOOLS=pda\\n' > ${dir}/spec.sh && echo "pda $(id -u pda) $(id -g pda)" > ${dir}/tools`,
				);
				expect(prepared.exitCode, prepared.text).toBe(0);
				getOrThrow(
					await box.upload(
						[{ path: `${dir}/launcher.sh`, bytes: new TextEncoder().encode(LAUNCHER_SCRIPT), mode: 0o700 }],
						context,
					),
				);
				// The check itself, with no launcher around it to clean up: the shim kills it at its first find, after the plant.
				await sh(box, `setsid sh ${dir}/launcher.sh tools-check ${dir} > /dev/null 2>&1; true`);
				const left = await sh(box, `stat -c '%a %s %U' ${dir}/tools.probe 2>/dev/null || echo gone`);
				expect(left.text.trim()).toBe("4700 0 root");
				const asPda = await sh(
					box,
					`setpriv --reuid=$(id -u pda) --regid=$(id -g pda) --clear-groups -- sh -c 'if [ -e "$1" ]; then echo reach; else echo none; fi; "$1" 2>/dev/null && echo ran || echo not-run' sh ${dir}/tools.probe`,
				);
				expect(asPda.text.trim().split("\n")).toEqual(["none", "not-run"]);
			});
		});

		it("gives an empty list of mounts unsupported: no mount walked is not a clean box", async () => {
			await withBox(shim("awk", 'case "$*" in *mountinfo*) exit 0 ;; esac; exec /usr/bin/awk "$@"'), async (box) => {
				const ran = await start(box);
				expect(ran.exitCode).toBe(10);
				expect(ran.out).toMatch(/^UNSUPPORTED the check found no mount to walk/m);
				expect(await exists(box, `${ran.dir}/launcher.pid`)).toBe(false);
			});
		});

		it("PROCEEDS as root with a valid tools user on a kernel with no Yama and on one whose scope is 0, and never touches the scope (case 2)", async () => {
			await withBox("printf '0\\n' > /tmp/zz-scope-0", async (box) => {
				for (const [kernel, file] of [
					["no Yama", "/nonexistent/yama/ptrace_scope"],
					["scope 0", "/tmp/zz-scope-0"],
				] as const) {
					expect(LAUNCHER_SCRIPT).toContain(PTRACE_FILE_LINE);
					const script = LAUNCHER_SCRIPT.replace(PTRACE_FILE_LINE, `PTRACE_FILE='${file}'`);
					// A vm: a ptrace check here would raise a writable 0 to 1, so a 0 left as it was shows no check ran.
					const spec = "GEN='g1'\nFRAMED=1\nTOOLS='pda'\nISOLATION='vm'\nrun_program() {\n  exec sleep 300\n}\n";
					const ran = await start(box, { script, spec });
					expect(ran.exitCode, `${kernel}: ${ran.out}`).toBe(0);
					await until(`the supervisor (${kernel})`, async () =>
						(await exists(box, `${ran.dir}/launcher.pid`)) ? true : undefined,
					);
				}
				expect(await exists(box, "/nonexistent/yama/ptrace_scope")).toBe(false);
				expect((await sh(box, "cat /tmp/zz-scope-0")).text.trim()).toBe("0");
			});
		});

		it("leaves no container behind", async () => {
			expect(getOrThrow(await dockerBoxes().list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("the tools user's check fails closed (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs only against a Docker daemon", () => {});
	});
}
