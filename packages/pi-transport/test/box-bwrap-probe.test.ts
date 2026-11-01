import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BWRAP_FLAGS, type BwrapProbeOptions, probeBwrap } from "../src/box/bwrap-args.ts";

// The probe against a fake `bwrap` on PATH: a shell script in a directory of this test's, which is the probe's whole PATH, so
// no other bwrap can be found. The probe reads `/proc/sys` only through the `sysctl` given here.

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A directory holding `bwrap`, the script given, and an empty scratch directory for the probe's workspace. */
function fake(
	script: string | undefined,
	mode = 0o755,
): { readonly dir: string; readonly scratch: string; readonly log: string } {
	const root = mkdtempSync(join(tmpdir(), "bwrap-probe-test-"));
	roots.push(root);
	const dir = join(root, "bin");
	const scratch = join(root, "scratch");
	mkdirSync(dir);
	mkdirSync(scratch);
	const log = join(root, "argv.log");
	if (script !== undefined) {
		writeFileSync(join(dir, "bwrap"), `#!/bin/sh\n${script.replaceAll("$LOG", log)}\n`);
		chmodSync(join(dir, "bwrap"), mode);
	}
	return { dir, scratch, log };
}

const VERSION = 'if [ "$1" = --version ]; then echo "bubblewrap 0.9.0"; exit 0; fi';
const noSysctl = () => undefined;
const probe = (f: { dir: string; scratch: string }, extra: Partial<BwrapProbeOptions> = {}) =>
	probeBwrap({ path: f.dir, scratch: f.scratch, sysctl: noSysctl, timeoutMs: 5000, ...extra });

describe("probeBwrap", () => {
	it("is available when bwrap answers its version and runs true in a box built as an exec's, with the box's files on their descriptors", async () => {
		const f = fake(`${VERSION}
printf '%s\\n' "$@" > "$LOG"
IFS= read -r passwd <&3 || { echo "no passwd on fd 3" >&2; exit 7; }
IFS= read -r group <&4 || { echo "no group on fd 4" >&2; exit 7; }
IFS= read -r hosts <&5 || { echo "no hosts on fd 5" >&2; exit 7; }
case "$passwd" in box:x:*:/workspace:/bin/sh) ;; *) echo "fd 3 held $passwd" >&2; exit 8;; esac
case "$group" in box:x:*) ;; *) echo "fd 4 held $group" >&2; exit 8;; esac
exit 0`);
		const found = await probe(f);
		expect(found).toEqual({ available: true, bwrap: join(f.dir, "bwrap"), version: "0.9.0" });
		const argv = readFileSync(f.log, "utf8").trimEnd().split("\n");
		for (const flag of BWRAP_FLAGS) expect(argv).toContain(flag);
		expect(argv.slice(argv.indexOf("--cap-drop"), argv.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
		expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "true"]);
		const bind = argv.indexOf("--bind");
		expect(argv[bind + 1]!.startsWith(f.scratch)).toBe(true);
		expect(argv[bind + 2]).toBe("/workspace");
		// The probe's workspace is gone once it answered.
		expect(readdirSync(f.scratch)).toEqual([]);
	});

	it("is missing when no executable bwrap is on PATH, or only one that cannot be executed", async () => {
		const none = fake(undefined);
		expect(await probe(none)).toEqual({
			available: false,
			code: "missing",
			reason: "bwrap is not installed: no executable bwrap is on PATH (install the bubblewrap package)",
		});
		const unexecutable = fake(VERSION, 0o644);
		expect(await probe(unexecutable)).toMatchObject({ available: false, code: "missing" });
		expect(await probe(none, { bwrap: "bwrap" })).toMatchObject({
			available: false,
			code: "missing",
			reason: expect.stringMatching(/is not an absolute path/),
		});
		expect(await probe(none, { bwrap: join(none.dir, "bwrap") })).toMatchObject({
			available: false,
			code: "missing",
			reason: expect.stringMatching(/does not exist/),
		});
	});

	it("is unavailable on a platform other than Linux, before looking for bwrap", async () => {
		const f = fake(VERSION);
		expect(await probe(f, { platform: "darwin" })).toEqual({
			available: false,
			code: "platform",
			reason: "a bwrap box runs on Linux, and this host is darwin",
		});
	});

	it("refuses a setuid bwrap without running it", async (context) => {
		const f = fake(`echo ran > "$LOG"; ${VERSION}`, 0o4755);
		if ((statSync(join(f.dir, "bwrap")).mode & 0o4000) === 0) context.skip();
		const found = await probe(f);
		expect(found).toMatchObject({
			available: false,
			code: "setuid",
			reason: expect.stringMatching(/is setuid: a box never runs a setuid bwrap/),
		});
		expect(existsSync(f.log)).toBe(false);
	});

	it("refuses a bwrap older than 0.8.0, and a version it cannot read", async () => {
		const old = fake('if [ "$1" = --version ]; then echo "bubblewrap 0.6.1"; exit 0; fi; exit 0');
		expect(await probe(old)).toEqual({
			available: false,
			code: "version",
			reason: "bwrap 0.6.1 is older than 0.8.0, the first with --disable-userns, which every box carries",
		});
		const garbled = fake('if [ "$1" = --version ]; then echo "bwrap, some version"; exit 0; fi; exit 0');
		expect(await probe(garbled)).toMatchObject({
			available: false,
			code: "version",
			reason: expect.stringMatching(/names no bubblewrap version/),
		});
		const failing = fake('echo "bwrap: cannot start" >&2; exit 3');
		expect(await probe(failing)).toMatchObject({
			available: false,
			code: "failed",
			reason: expect.stringMatching(/--version exited 3: "bwrap: cannot start"/),
		});
	});

	it("names AppArmor's restriction when bwrap is denied a user namespace on a host that sets it", async () => {
		const f = fake(`${VERSION}
echo "bwrap: setting up uid map: Permission denied" >&2
exit 1`);
		const found = await probe(f, {
			sysctl: (name) => (name === "kernel.apparmor_restrict_unprivileged_userns" ? "1" : undefined),
		});
		expect(found).toEqual({
			available: false,
			code: "userns_denied",
			reason:
				'AppArmor restricts unprivileged user namespaces on this host (kernel.apparmor_restrict_unprivileged_userns = 1): bwrap needs an AppArmor profile that grants it userns, which the host\'s operator loads once; bwrap said: "bwrap: setting up uid map: Permission denied"',
		});
	});

	it("names the sysctl that turns user namespaces off, and says so plainly when no setting explains the denial", async () => {
		const f = fake(`${VERSION}
echo "bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces." >&2
exit 1`);
		const clone = await probe(f, {
			sysctl: (name) => (name === "kernel.unprivileged_userns_clone" ? "0" : undefined),
		});
		expect(clone).toMatchObject({
			available: false,
			code: "userns_denied",
			reason: expect.stringMatching(
				/^this host turns unprivileged user namespaces off \(kernel\.unprivileged_userns_clone = 0\); bwrap said: /,
			),
		});
		const max = await probe(f, { sysctl: (name) => (name === "user.max_user_namespaces" ? "0" : undefined) });
		expect(max).toMatchObject({
			code: "userns_denied",
			reason: expect.stringMatching(/^this host allows no user namespaces \(user\.max_user_namespaces = 0\)/),
		});
		const loopback = fake(`${VERSION}
echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2
exit 1`);
		expect(await probe(loopback)).toMatchObject({
			code: "userns_denied",
			reason: expect.stringMatching(/^this host denies bwrap a user namespace; bwrap said: "bwrap: loopback/),
		});
	});

	it("is failed with what bwrap said when the box cannot run true for another reason", async () => {
		const f = fake(`${VERSION}
echo "bwrap: execvp true: No such file or directory" >&2
exit 1`);
		expect(await probe(f)).toEqual({
			available: false,
			code: "failed",
			reason: 'bwrap could not run true in a box: it exited 1: "bwrap: execvp true: No such file or directory"',
		});
	});

	it("kills a bwrap that does not answer within the bound, its version or its box, and says which", async () => {
		const pid = (f: { log: string }) => Number(readFileSync(f.log, "utf8"));
		const gone = (n: number) => {
			try {
				process.kill(n, 0);
				return false;
			} catch {
				return true;
			}
		};
		const version = fake('echo $$ > "$LOG"; exec sleep 30');
		const started = Date.now();
		expect(await probe(version, { timeoutMs: 300 })).toEqual({
			available: false,
			code: "timeout",
			reason: `${join(version.dir, "bwrap")} --version did not answer within 300 ms and was killed`,
		});
		expect(Date.now() - started).toBeLessThan(3000);
		expect(gone(pid(version))).toBe(true);
		const box = fake(`${VERSION}
echo $$ > "$LOG"
exec sleep 30`);
		expect(await probe(box, { timeoutMs: 300 })).toEqual({
			available: false,
			code: "timeout",
			reason: "bwrap did not run true in a box within 300 ms and was killed",
		});
		expect(gone(pid(box))).toBe(true);
		expect(readdirSync(box.scratch)).toEqual([]);
	});

	it("says so when its own box is refused, as for a scratch directory under /dev, and leaves nothing there", async (context) => {
		if (!existsSync("/dev/shm")) context.skip();
		const f = fake(`${VERSION}
echo ran > "$LOG"
exit 0`);
		const before = readdirSync("/dev/shm").filter((name) => name.startsWith("bwrap-probe-"));
		const found = await probe(f, { scratch: "/dev/shm" });
		expect(found).toMatchObject({
			available: false,
			code: "failed",
			reason: expect.stringMatching(
				/^the probe's own box is refused: the workspace \/dev\/shm\/bwrap-probe-\S+ lies under \/dev, which a box never sees$/,
			),
		});
		expect(existsSync(f.log)).toBe(false);
		expect(readdirSync("/dev/shm").filter((name) => name.startsWith("bwrap-probe-"))).toEqual(before);
	});
});
