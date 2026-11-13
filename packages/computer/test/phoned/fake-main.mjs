// phoned's real Java core over its scripted phone (daemon-android/src/fake), started as a child of this process: the
// TypeScript side's tests and the live probe's dry run talk to the code that runs on a phone, with a JDK and no phone.
// `npm run test:phoned` builds daemon-android/build/fake-classes first (build-phoned.mjs --fake).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

export const FAKE_CLASSES = fileURLToPath(new URL("../../daemon-android/build/fake-classes", import.meta.url));

/** java from JAVA_HOME, else PATH. */
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";

/**
 * Starts FakeMain: { stream, child, exited }. stream is its stdio as one Duplex (stdout to read, stdin to write); ending
 * stream's writable side closes its stdin, which ends it. Its exec.run runs on this machine in a scratch directory.
 * phone: a directory standing for the phone, where every FakeMain started on it keeps the phone's one UiAutomation
 * registration (its file `uiautomation` holds the holder's pid); exitMs: how long it keeps that registration after its
 * stdin closes before it lets go and exits.
 */
export function startFakeMain({ phone, exitMs = 0 } = {}) {
	if (!existsSync(FAKE_CLASSES)) throw new Error(`${FAKE_CLASSES} is missing: run node scripts/build-phoned.mjs --fake first (npm run test:phoned does)`);
	const home = mkdtempSync(join(tmpdir(), "phoned-home-"));
	const props = [...(phone === undefined ? [] : [`-Dphoned.fake.phone=${phone}`]), `-Dphoned.fake.exitMs=${exitMs}`];
	const child = spawn(java, [...props, "-cp", FAKE_CLASSES, "ai.agentrun.phoned.fake.FakeMain", home], { stdio: ["pipe", "pipe", "inherit"] });
	const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
	return { stream, child, exited, home };
}
