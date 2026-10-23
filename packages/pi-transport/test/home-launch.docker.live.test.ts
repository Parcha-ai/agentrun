import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { launch, launchStatus } from "../src/launch/launch.ts";
import { expectUnsafe, registerLaunchSuite, sh, spoolOf } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const labels = { "pi-transport-live": `launch-${process.pid}-${Date.now()}` };

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
// PI_TRANSPORT_LIVE_DOCKER_IMAGE runs one image instead of the default pair.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	const provider = dockerBoxes();
	// dash (Debian) and BusyBox (Alpine) differ in how `kill` takes a process group, so both run unless one is named.
	const named = process.env.PI_TRANSPORT_LIVE_DOCKER_IMAGE;
	const images: (string | undefined)[] = named === undefined || named === "" ? [undefined, "alpine:3.20"] : [named];
	for (const image of images) {
		registerLaunchSuite(`a Docker box (${image ?? "default image"})`, async (use) => {
			const box = getOrThrow(
				await provider.create(
					{ maxLifetimeMs: 10 * 60_000, labels, ...(image === undefined ? {} : { image }) },
					context,
				),
			);
			try {
				await use(box);
			} finally {
				await box.destroy(context);
			}
		});
	}

	describe("the launcher's directories in a root container: another uid's", () => {
		for (const image of images) {
			it(`${image ?? "default image"}: a spool or a launch directory another uid owns is refused, and nothing is made or run in it`, async () => {
				const box = getOrThrow(
					await provider.create(
						{ maxLifetimeMs: 10 * 60_000, labels, ...(image === undefined ? {} : { image }) },
						context,
					),
				);
				try {
					const spool = await spoolOf(box);
					const spec = { argv: ["sh", "-c", "echo $$ >> prog.pids; exec sleep 300"] };
					const owned = /belongs to uid 65534, not to the launcher's uid 0/;
					expect((await sh(box, `mkdir -m 700 "${spool}" && chown 65534 "${spool}"`)).exitCode).toBe(0);
					expectUnsafe(await launch(box, "owned", spec, context), owned);
					expect((await sh(box, `ls -A "${spool}"`)).text).toBe("");
					// The spool is root's again; a launch directory in it is not.
					await sh(box, `chown 0 "${spool}" && mkdir -m 700 "${spool}/owned" && chown 65534 "${spool}/owned"`);
					expectUnsafe(await launch(box, "owned", spec, context), owned);
					expectUnsafe(await launchStatus(box, "owned", context), owned);
					expect((await sh(box, `ls -A "${spool}/owned"; cat prog.pids 2>/dev/null`)).text).toBe("");
					// Root's, it is the launcher's own: an abandoned claim, taken over at once.
					await sh(box, `chown 0 "${spool}/owned" && echo 1 > "${spool}/owned/claimed.at"`);
					expect(getOrThrow(await launch(box, "owned", spec, context)).phase).toBe("running");
				} finally {
					await box.destroy(context);
				}
			}, 300_000);

			it(`${image ?? "default image"}: a directory above the spool another uid owns is refused, sticky or not`, async () => {
				const box = getOrThrow(
					await provider.create(
						{ maxLifetimeMs: 10 * 60_000, labels, ...(image === undefined ? {} : { image }) },
						context,
					),
				);
				try {
					const spec = { argv: ["sh", "-c", "echo $$ >> prog.pids; exec sleep 300"] };
					const owned = /^\/tmp, above the spool, belongs to uid 65534: neither root nor the launcher's uid 0/;
					// Sticky, and then open to all without it: neither excuses another owner.
					for (const mode of ["1777", "777"]) {
						expect((await sh(box, `chown 65534 /tmp && chmod ${mode} /tmp`)).exitCode).toBe(0);
						expectUnsafe(await launch(box, "above", spec, context), owned, `mode ${mode}`);
					}
					expect((await sh(box, "cat prog.pids 2>/dev/null")).text).toBe("");
					// Root's and sticky, as a box's /tmp is.
					await sh(box, "chown 0 /tmp && chmod 1777 /tmp");
					expect(getOrThrow(await launch(box, "above", spec, context)).phase).toBe("running");
				} finally {
					await box.destroy(context);
				}
			}, 300_000);
		}
	});

	describe("the launcher in Docker boxes", () => {
		it("leaves no container behind", async () => {
			expect(getOrThrow(await provider.list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("the launcher in Docker boxes (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the launcher suite in Docker containers", () => {});
	});
}
