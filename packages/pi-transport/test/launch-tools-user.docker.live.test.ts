// The tools user (`LaunchSpec.toolsUser`) in a Docker box whose exec user is root: a framed launch may run as root only with a
// verified non-root tools user. The image is built once per run: Debian with sudo, libcap2-bin and ping, every setuid and
// setgid bit stripped and ping's capability removed, and a user `pda`; each case plants only what it tests. The messages are
// asserted by their exact prefixes. Never a secret's value: a hash and a count. Needs a Docker daemon and the network (apt):
// `npm run test:live:docker`.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { type LaunchSpec, type LaunchState, launch, launchSpecError, launchStop } from "../src/launch/index.ts";
import { sh, until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const labels = { "pi-transport-live": `launch-tools-user-${process.pid}-${Date.now()}` };
const IMAGE = `pi-transport-tools-user-test:${process.pid}`;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The spec's fields this file uses, whether or not the package's types name them yet. */
type Spec = LaunchSpec & { readonly toolsUser?: string };
type State = LaunchState & { readonly toolsUser?: { readonly name: string; readonly uid: number } };

const DOCKERFILE = [
	"FROM debian:bookworm-slim",
	"RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo libcap2-bin iputils-ping && rm -rf /var/lib/apt/lists/*",
	"RUN useradd -m -s /bin/sh pda",
	// Nothing in the image may run with root's rights, so each case holds only what it plants.
	'RUN find / -xdev \\( -perm -4000 -o -perm -2000 \\) -type f -exec chmod u-s,g-s {} + ; for p in $(command -v ping) /bin/ping /usr/bin/ping; do [ -e "$p" ] && setcap -r "$p" 2>/dev/null; done; true',
].join("\n");

function docker(args: string[], input?: string) {
	return spawnSync("docker", args, { encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

/** A box of the test image, prepared as root by `setup` (a script that must succeed), used by `use`, and always ended. */
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

/** A framed spec (it carries a stdin) that names `toolsUser` and nothing else about who it runs as: the box's exec user is root. */
const framed = (toolsUser: string | undefined, argv: readonly string[] = ["sleep", "300"]): Spec => ({
	argv,
	stdin: new TextEncoder().encode("input\n"),
	...(toolsUser === undefined ? {} : { toolsUser }),
});

async function refusal(box: Box, name: string, spec: Spec) {
	const result = await launch(box, name, spec, context);
	return result.ok ? undefined : { code: result.error.code, message: result.error.message };
}

if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	// Each case makes a container and may run the launcher's checks inside it: a hang guard, not a speed claim.
	vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 });
	beforeAll(() => {
		const built = docker(["build", "-t", IMAGE, "-"], DOCKERFILE);
		if (built.status !== 0) throw new Error(`could not build the test image: ${String(built.stderr).slice(-400)}`);
	}, 600_000);

	afterAll(() => {
		docker(["rmi", "-f", IMAGE]);
	});

	describe("a framed launch in a root box, with a tools user", () => {
		it("T1: proceeds with a verified non-root tools user: the program is root, reads its secrets, and its state and environment name the tools user", async () => {
			await withBox(undefined, async (box) => {
				const secret = `sec-${randomBytes(12).toString("hex")}`;
				const secrets = { MODAL_TOKEN_ID: secret };
				const uid = Number((await sh(box, "id -u pda")).text.trim());
				const program = [
					"sh",
					"-c",
					'id -u > /tmp/uid; printf "%s %s" "$PI_TRANSPORT_TOOLS_USER" "$PI_TRANSPORT_TOOLS_UID" > /tmp/tools; cat <&"$PI_TRANSPORT_SECRETS_FD" | sha256sum | cut -c1-64 > /tmp/sec; exec sleep 300',
				];
				const started = getOrThrow(
					await launch(box, "tools", { ...framed("pda", program), cwd: "/tmp", secrets } as Spec, context),
				) as State;
				expect(started.toolsUser).toEqual({ name: "pda", uid });
				const read = async (path: string) => {
					const got = await box.download([path], context);
					return got.ok ? new TextDecoder().decode(got.value[0]?.bytes) : undefined;
				};
				expect((await until("the program's uid", () => read("/tmp/uid"))).trim()).toBe("0");
				expect(await until("its environment", () => read("/tmp/tools"))).toBe(`pda ${uid}`);
				expect((await until("its secrets", () => read("/tmp/sec"))).trim()).toBe(sha(JSON.stringify(secrets)));
				getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
			});
		});

		it("T2: a framed launch as root with no tools user is refused by the pure check, and, past it, by the launcher in the box", async () => {
			const MESSAGE = "a launch with stdin or secrets runs its program as root (uid 0) only with a toolsUser";
			// The pure half: user "root", no toolsUser.
			const pure = launchSpecError("asroot", { ...framed(undefined), user: "root" });
			expect(pure?.code).toBe("invalid");
			expect(pure?.message.startsWith(MESSAGE)).toBe(true);
			// The in-box half, through launch() itself: a second uid-0 entry passes the pure check ("toor" is not root or zeros), and the
			// launcher refuses it in the box.
			await withBox("echo 'toor:x:0:0:toor:/root:/bin/sh' >> /etc/passwd", async (box) => {
				const spec: Spec = { ...framed(undefined), user: "toor" };
				expect(launchSpecError("viatoor", spec)).toBeUndefined();
				const refused = await refusal(box, "viatoor", spec);
				expect(refused?.code).toBe("invalid");
				expect(refused?.message.startsWith(MESSAGE)).toBe(true);
				// user "toor" WITH a toolsUser: the pure check refuses it (a toolsUser goes only with user "root" or a uid of zeros).
				const both = launchSpecError("both", { ...framed("pda"), user: "toor" });
				expect(both?.code).toBe("invalid");
				expect(both?.message.startsWith("toolsUser goes only with a program run as root")).toBe(true);
			});
		});

		it("T3: a tools user the box does not have is invalid", async () => {
			await withBox("userdel -r pda", async (box) => {
				const refused = await refusal(box, "nouser", framed("pda"));
				expect(refused?.code).toBe("invalid");
				expect(refused?.message.startsWith("there is no tools user pda in this box")).toBe(true);
			});
		});

		it("T4: a second uid-0 entry as the tools user is invalid", async () => {
			await withBox("echo 'toor:x:0:0:toor:/root:/bin/sh' >> /etc/passwd", async (box) => {
				const refused = await refusal(box, "toor", framed("toor"));
				expect(refused?.code).toBe("invalid");
				expect(refused?.message.startsWith("the tools user toor is root (uid 0)")).toBe(true);
			});
		});

		it("T5: a tools user with gid 0 is invalid", async () => {
			await withBox("usermod -g 0 pda", async (box) => {
				const refused = await refusal(box, "gid0", framed("pda"));
				expect(refused?.code).toBe("invalid");
				expect(refused?.message.startsWith("the tools user pda has the root group (gid 0)")).toBe(true);
			});
		});

		it("T6a: a sudo rule for the tools user is refused by sudo, though sudo itself is 4750 root:root", async () => {
			const setup = [
				"printf 'pda ALL=(ALL) NOPASSWD: ALL\\n' > /etc/sudoers.d/pda",
				"chmod 440 /etc/sudoers.d/pda",
				"chown root:root /usr/bin/sudo",
				"chmod 4750 /usr/bin/sudo",
			].join(" && ");
			await withBox(setup, async (box) => {
				const refused = await refusal(box, "sudorule", framed("pda"));
				expect(refused?.code).toBe("refused");
				expect(refused?.message.startsWith("sudo does not say the tools user pda may run nothing: ")).toBe(true);
			});
		});

		it("T6b: sudo at 4755 with no rule is refused, naming /usr/bin/sudo", async () => {
			await withBox("chown root:root /usr/bin/sudo && chmod 4755 /usr/bin/sudo", async (box) => {
				const refused = await refusal(box, "sudosuid", framed("pda"));
				expect(refused?.code).toBe("refused");
				expect(refused?.message.startsWith("the tools user pda can run a setuid or setgid root file: ")).toBe(true);
				expect(refused?.message).toContain("/usr/bin/sudo");
			});
		});

		it("T7: a planted 4755 root binary is refused, naming it; the same file at 4750 is accepted", async () => {
			const plant = (mode: string) =>
				`cp /bin/true /usr/local/bin/rootbin && chown root:root /usr/local/bin/rootbin && chmod ${mode} /usr/local/bin/rootbin`;
			await withBox(plant("4755"), async (box) => {
				const refused = await refusal(box, "rootbin", framed("pda"));
				expect(refused?.code).toBe("refused");
				expect(refused?.message.startsWith("the tools user pda can run a setuid or setgid root file: ")).toBe(true);
				expect(refused?.message).toContain("/usr/local/bin/rootbin");
			});
			await withBox(plant("4750"), async (box) => {
				const started = await launch(box, "rootbin", framed("pda"), context);
				expect(started.ok ? "ok" : `${started.error.code}: ${started.error.message.slice(0, 120)}`).toBe("ok");
				if (started.ok) getOrThrow(await launchStop(box, started.value.launch, { graceMs: 1_000 }, context));
			});
		});

		it("T7 (711): a 4755 root file in a directory the tools user can pass through but not list is refused, naming it: the launcher lists as root and tests each file as the tools user", async () => {
			await withBox(
				"mkdir -m 711 /opt/hidden && cp /bin/true /opt/hidden/s && chown root:root /opt/hidden/s && chmod 4755 /opt/hidden/s",
				async (box) => {
					const refused = await refusal(box, "hidden", framed("pda"));
					expect(refused?.code).toBe("refused");
					expect(refused?.message.startsWith("the tools user pda can run a setuid or setgid root file: ")).toBe(
						true,
					);
					expect(refused?.message).toContain("/opt/hidden/s");
				},
			);
		});

		it("T7 (nosuid): the same 4755 root file on a nosuid mount (/dev) is accepted: only skipping nosuid mounts accepts it", async () => {
			await withBox(
				"cp /bin/true /dev/zz-setuid && chown root:root /dev/zz-setuid && chmod 4755 /dev/zz-setuid",
				async (box) => {
					const started = await launch(box, "nosuid", framed("pda"), context);
					expect(started.ok ? "ok" : `${started.error.code}: ${started.error.message.slice(0, 160)}`).toBe("ok");
					if (started.ok) getOrThrow(await launchStop(box, started.value.launch, { graceMs: 1_000 }, context));
				},
			);
		});

		it("T8: a file with capabilities is refused, naming it and its capabilities; a box with no getcap is unsupported", async () => {
			await withBox(
				"cp /bin/true /usr/local/bin/capcopy && chown root:root /usr/local/bin/capcopy && chmod 0755 /usr/local/bin/capcopy && setcap cap_net_raw+ep /usr/local/bin/capcopy",
				async (box) => {
					const refused = await refusal(box, "capcopy", framed("pda"));
					expect(refused?.code).toBe("refused");
					expect(refused?.message.startsWith("the tools user pda can run a file with capabilities: ")).toBe(true);
					expect(refused?.message).toContain("/usr/local/bin/capcopy");
					expect(refused?.message).toContain("cap_net_raw");
				},
			);
			await withBox(
				'for g in $(command -v getcap) /sbin/getcap /usr/sbin/getcap; do [ -e "$g" ] && mv "$g" "$g.off"; done; true',
				async (box) => {
					const refused = await refusal(box, "nogetcap", framed("pda"));
					expect(refused?.code).toBe("unsupported");
					expect(refused?.message.startsWith("this box has no getcap to measure file capabilities")).toBe(true);
				},
			);
		});

		it("leaves no container behind", async () => {
			expect(getOrThrow(await dockerBoxes().list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("a framed launch in a root box, with a tools user (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs only against a Docker daemon", () => {});
	});
}
