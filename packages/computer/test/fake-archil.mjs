// The Archil side of the computer tests, with no vendor: the helper's root verbs as a computer's root runs them, what
// the preflight prints in a computer the Archil image made, the mount table a mount leaves, and a fake of an Archil
// disk's object API (the outside of a conformance run folder). The adapter's fake host (fake-host.mjs) and the
// conformance modules' tests share it. Nothing reaches the network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The first line of the preflight script, by which a fake knows it. */
export const PREFLIGHT_MARK = "# agentrun-computer: archil preflight";
export const ARCHIL_HELPER = "/usr/local/sbin/agentrun-archil";
const HELPER_SHA = createHash("sha256").update(readFileSync(new URL("../box/agentrun-archil", import.meta.url))).digest("hex");
/** What the preflight prints in a computer as the Archil image makes it. */
export const GOOD_PREFLIGHT = ["uid 0", `helper ${HELPER_SHA} -rwxr-xr-x 0 0`, "archil Archil Client: v0.10.1-1793222256, 1001, proto=Version2", "tool 2510:2510", "sudo none", "fuse present"].join("\n");
/** The verb of a root command: the helper's, or the preflight; undefined for any other command. */
export function rootVerb(command) {
	if (command?.[0] === ARCHIL_HELPER) return command[1];
	if (command?.[0] === "sh" && command[1] === "-c" && typeof command[2] === "string" && command[2].startsWith(`${PREFLIGHT_MARK}\n`)) return "preflight";
	return undefined;
}
/**
 * A fake of an Archil disk's object API, the outside of a run folder in the conformance modules: keys relative to the
 * disk's root; a missing key throws as the SDK does, with status 404, and a key holding "broken" with status 500.
 */
export function fakeObjects() {
	const objects = new Map();
	const calls = [];
	return {
		objects,
		calls,
		async getObject(key) {
			calls.push(["getObject", key]);
			if (key.includes("broken")) throw Object.assign(new Error("500: the disk is unreachable"), { status: 500 });
			if (!objects.has(key)) throw Object.assign(new Error(`404: ${key} not found`), { status: 404 });
			return new Uint8Array(objects.get(key));
		},
		async putObject(key, body) {
			calls.push(["putObject", key]);
			objects.set(key, Buffer.from(body));
		},
		async deleteObject(key) {
			calls.push(["deleteObject", key]);
			objects.delete(key);
		},
	};
}

/** The mount table a sandbox's daemon reads at /proc/self/mounts. */
export function mountsOf(box) {
	const lines = ["proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0", "overlay / overlay rw,relatime 0 0"];
	if (box.mounted) {
		const { disk, folder } = box.mounted;
		lines.push(`${box.mountSource ?? `${disk}:/${folder}`} /workspace ${box.mountType ?? "fuse.archil"} rw,nosuid,nodev,relatime,user_id=0,group_id=0,allow_other 0 0`);
	}
	return `${lines.join("\n")}\n`;
}
