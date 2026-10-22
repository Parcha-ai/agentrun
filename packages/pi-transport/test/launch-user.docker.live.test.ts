// T3 in a container whose exec user is root: the launcher drops a framed launch to the user it names, the program gets
// its stdin and secrets, and neither is anywhere in the container afterwards (files, any process's environ or cmdline).
// Where the image has neither setpriv nor runuser (Alpine), another user is refused. Needs a Docker daemon:
// `npm run test:live:docker`.
import { createHash, randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { finish } from "../src/box/files.ts";
import { launch, launchState, launchStop } from "../src/launch/index.ts";
import { LAUNCHER_SCRIPT } from "../src/launch/launcher-script.ts";
import { until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const labels = { "pi-transport-live": `launch-user-${process.pid}-${Date.now()}` };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A script run in the box with `input` on its stdin (never in its argv): its stdout. */
async function run(box: Box, script: string, input: string): Promise<string> {
	const started = getOrThrow(await box.exec(["sh", "-c", script], { timeoutMs: 60_000 }, context));
	await started.stdin.write(new TextEncoder().encode(input));
	await started.stdin.close();
	const done = getOrThrow(await finish(started));
	return new TextDecoder().decode(done.stdout);
}

/** Where a marker is in the box, found by the box's own sh with the marker on its stdin: files under /tmp, /root, /var
 *  and /run, and every process's environ and cmdline. The search's own processes never hold it in an argv. */
const FIND = [
	"IFS= read -r pat",
	'for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do c=$(tr "\\000" " " < "$f" 2>/dev/null); case "$c" in *"$pat"*) echo "HIT $f" ;; esac; done',
	'find /tmp /root /var /run -type f 2>/dev/null | while IFS= read -r f; do c=$(tr "\\000" " " < "$f" 2>/dev/null); case "$c" in *"$pat"*) echo "HIT $f" ;; esac; done',
	"echo SEARCHED",
].join("\n");

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
}

if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	const provider = dockerBoxes();

	describe("a framed launch in a root container", () => {
		it("runs as the user it names (setpriv, Debian), gets its stdin and secrets, and leaves neither anywhere in the container", async () => {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000, labels }, context));
			try {
				const token = `tok-${randomBytes(12).toString("hex")}`;
				const secret = `sec-${randomBytes(12).toString("hex")}`;
				const stdin = new TextEncoder().encode(`${token}\n`);
				const secrets = { MODAL_TOKEN_ID: secret };
				const program = [
					"sh",
					"-c",
					'id -u > /tmp/uid; sha256sum | cut -c1-64 > /tmp/in; cat <&"$PI_TRANSPORT_SECRETS_FD" | sha256sum | cut -c1-64 > /tmp/sec; exec sleep 300',
				];
				const started = getOrThrow(
					await launch(box, "asnobody", { argv: program, cwd: "/tmp", user: "nobody", stdin, secrets }, context),
				);
				expect(started.user).toEqual({ name: "nobody", uid: 65534 });
				expect((await until("the program's uid", () => fileIn(box, "/tmp/uid")))?.trim()).toBe("65534");
				expect((await until("its stdin", () => fileIn(box, "/tmp/in")))?.trim()).toBe(sha(stdin));
				expect((await until("its secrets", () => fileIn(box, "/tmp/sec")))?.trim()).toBe(
					sha(JSON.stringify(secrets)),
				);
				const encoded = [
					Buffer.from(stdin).toString("base64"),
					Buffer.from(JSON.stringify(secrets)).toString("base64"),
				];
				for (const marker of [token, secret, ...encoded]) {
					const found = await run(box, FIND, `${marker}\n`);
					expect(found).toContain("SEARCHED");
					expect(found.split("\n").filter((line) => line.startsWith("HIT "))).toEqual([]);
				}
				getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
			} finally {
				await box.destroy(context);
			}
		});

		it("refuses a framed launch with no user from the root launcher, and another user where the image has neither setpriv nor runuser (Alpine)", async () => {
			const debian = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000, labels }, context));
			try {
				const bare = await launch(
					debian,
					"nouser",
					{ argv: ["sleep", "300"], stdin: new Uint8Array([1]) },
					context,
				);
				expect(bare.ok ? undefined : bare.error.code).toBe("invalid");
				expect(
					getOrThrow(await launchState(debian, { v: 1, name: "nouser" }, context))?.launcherAlive ?? false,
				).toBe(false);
			} finally {
				await debian.destroy(context);
			}
			const alpine = getOrThrow(
				await provider.create({ maxLifetimeMs: 10 * 60_000, labels, image: "alpine:3.20" }, context),
			);
			try {
				const refused = await launch(
					alpine,
					"nobodyhere",
					{ argv: ["sleep", "300"], user: "nobody", stdin: new Uint8Array([1]) },
					context,
				);
				expect(refused.ok ? undefined : refused.error.code).toBe("unsupported");
			} finally {
				await alpine.destroy(context);
			}
		});

		it("checks a root program's tools user BEFORE it reads the frame: a failed check refuses (8), never a frame error (7)", async () => {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000, labels }, context));
			try {
				const dir = "/tmp/order-check";
				getOrThrow(
					await box.upload(
						[
							{ path: `${dir}/launcher.sh`, bytes: new TextEncoder().encode(LAUNCHER_SCRIPT), mode: 0o700 },
							{
								path: `${dir}/spec.sh`,
								bytes: new TextEncoder().encode(
									"GEN='g1'\nFRAMED=1\nTOOLS='nosuchuser'\nISOLATION='none'\nrun_program() {\n  exec true\n}\n",
								),
								mode: 0o600,
							},
						],
						context,
					),
				);
				// A malformed frame: a launcher that read it first would answer 7.
				const started = getOrThrow(
					await box.exec(["sh", `${dir}/launcher.sh`, "start", dir], { timeoutMs: 60_000 }, context),
				);
				const done = getOrThrow(await finish(started, new TextEncoder().encode("not a frame\n")));
				expect(done.exitCode).toBe(8);
				expect(new TextDecoder().decode(done.stdout)).toMatch(
					/^INVALID there is no tools user nosuchuser in this box/m,
				);
				expect(await fileIn(box, `${dir}/launcher.pid`)).toBeUndefined();
			} finally {
				await box.destroy(context);
			}
		});

		it("leaves no container behind", async () => {
			expect(getOrThrow(await provider.list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("a framed launch in a root container (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs as the user it names", () => {});
	});
}
