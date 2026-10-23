// The mounts the tools user's check walks (V4) are chosen by FILESYSTEM TYPE from the mount table, never by mount point: every
// mount without nosuid except a closed list of the kernel's pseudo filesystems. This runs the launcher script's own selection
// (`tools_mounts`) over mount tables the test writes; the walk itself, with a real find, is in launch-mount-walk.docker.live.test.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAUNCHER_SCRIPT } from "../src/launch/launcher-script.ts";

/** The script's selection function, cut out of the script text and run by `sh` over a mount table. */
function selected(table: string): string[] {
	const start = LAUNCHER_SCRIPT.indexOf("tools_mounts() {");
	if (start < 0) throw new Error("the launcher script has no tools_mounts");
	const end = LAUNCHER_SCRIPT.indexOf("\n}\n", start) + 3;
	const dir = mkdtempSync(join(tmpdir(), "mount-walk-"));
	try {
		const file = join(dir, "mountinfo");
		writeFileSync(file, table);
		const ran = spawnSync(
			"sh",
			["-c", `MOUNTINFO_FILE="$1"; ${LAUNCHER_SCRIPT.slice(start, end)}\ntools_mounts`, "sh", file],
			{
				encoding: "utf8",
			},
		);
		expect(ran.status, ran.stderr).toBe(0);
		return ran.stdout.split("\n").filter(Boolean);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let id = 100;
/** One mountinfo line: id, parent, device, root, mount point, options, optional fields, ' - ', type, source, super options. */
const mount = (point: string, type: string, options = "rw,relatime", optional = "") =>
	`${id++} 1 0:${id} / ${point} ${options}${optional ? ` ${optional}` : ""} - ${type} ${type} rw`;

const PSEUDO = [
	"proc",
	"sysfs",
	"cgroup",
	"cgroup2",
	"devpts",
	"mqueue",
	"securityfs",
	"debugfs",
	"tracefs",
	"bpf",
	"pstore",
	"configfs",
	"fusectl",
	"binfmt_misc",
	"efivarfs",
];

describe("the mounts the tools check walks", () => {
	it("skips each pseudo filesystem of the closed list, without nosuid, and only by its type", () => {
		for (const type of PSEUDO) expect(selected(`${mount("/somewhere", type)}\n`), type).toEqual([]);
		// the same list, one mount each, beside a real one: only the real one is walked
		const table = [...PSEUDO.map((type) => mount(`/pseudo/${type}`, type)), mount("/data", "ext4")].join("\n");
		expect(selected(`${table}\n`)).toEqual(["/data"]);
	});

	it("walks tmpfs and devtmpfs without nosuid, and every other type, an unknown one included", () => {
		const types = [
			"tmpfs",
			"devtmpfs",
			"ext4",
			"xfs",
			"btrfs",
			"overlay",
			"9p",
			"fuse.sshfs",
			"virtiofs",
			"zzfs-not-a-type",
		];
		for (const type of types) expect(selected(`${mount(`/m/${type}`, type)}\n`), type).toEqual([`/m/${type}`]);
	});

	it("skips a mount with nosuid, whatever its type, and reads past optional fields to the type", () => {
		expect(selected(`${mount("/dev", "tmpfs", "rw,nosuid,relatime")}\n`)).toEqual([]);
		expect(selected(`${mount("/x", "ext4", "rw,nosuid")}\n`)).toEqual([]);
		// shared:/master: fields sit between the options and the ' - '
		expect(selected(`${mount("/y", "ext4", "rw,relatime", "shared:5 master:2")}\n`)).toEqual(["/y"]);
		expect(selected(`${mount("/z", "proc", "rw,relatime", "shared:5 master:2")}\n`)).toEqual([]);
	});

	it("chooses by type, never by mount point: a pseudo type anywhere is skipped, a real one named proc or sys is walked", () => {
		expect(selected(`${mount("/data", "proc")}\n${mount("/also", "sysfs")}\n`)).toEqual([]);
		expect(selected(`${mount("/proc", "ext4")}\n${mount("/sys", "tmpfs")}\n`)).toEqual(["/proc", "/sys"]);
	});

	it("gives a mount point as the table writes it, escapes included, for the walk to decode", () => {
		expect(selected(`${mount("/mnt/with\\040space", "ext4")}\n`)).toEqual(["/mnt/with\\040space"]);
	});
});
