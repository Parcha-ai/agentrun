/**
 * What one exec in a new box reads, so the facts are what the box has and not what was asked: the size of the workspace's
 * filesystem in KiB, the Yama setting (a box without it reads 0), and, when `fuse` was asked for, whether `/dev/fuse` is a character
 * device that the user of this exec (root, in a box) can open: a FUSE mount there is root's. The workspace (`$1`) and the request
 * (`$2`, `fuse` or `-`) come as arguments, never in the text.
 */
export const PROBE = [
	'echo "disk=$(df -Pk "$1" 2>/dev/null | awk \'NR==2{print $2}\')"',
	"if [ -r /proc/sys/kernel/yama/ptrace_scope ]; then p=$(cat /proc/sys/kernel/yama/ptrace_scope); else p=0; fi",
	'echo "ptrace=$p"',
	'if [ "$2" = fuse ]; then',
	"  dev=0",
	"  if [ -c /dev/fuse ] && sh -c 'exec 3<>/dev/fuse' 2>/dev/null; then dev=1; fi",
	'  echo "fuse_dev=$dev"',
	"fi",
].join("\n");

/** What the probe's output says. A fact the box did not give is left out. */
export type ProbeReading = {
	readonly diskGb?: number;
	readonly ptraceScope?: 0 | 1 | 2 | 3;
	/** `true` only when `/dev/fuse` is a character device that the probe's own user (root, in a box) can open. */
	readonly fuse: boolean;
	/** What FUSE lacks, in words, when it lacks something. */
	readonly fuseMissing: readonly string[];
};

/**
 * The largest disk the facts will report: 1 PiB. Beyond it `df` is not describing a disk (gVisor's filesystem reports 2^63 bytes), and
 * the fact is left out as unknown rather than reported as a size nothing has.
 */
const MAX_DISK_GIB = 1024 * 1024;

export function parseProbe(output: string): ProbeReading {
	const read = new Map(output.split("\n").map((line) => line.split("=") as [string, string]));
	const kib = Number(read.get("disk"));
	const ptrace = read.get("ptrace");
	const dev = read.get("fuse_dev") === "1";
	return {
		...(read.get("disk") !== undefined &&
		read.get("disk") !== "" &&
		Number.isFinite(kib) &&
		kib > 0 &&
		kib / (1024 * 1024) <= MAX_DISK_GIB
			? { diskGb: Math.floor(kib / (1024 * 1024)) }
			: {}),
		...(ptrace !== undefined && /^[0-3]$/.test(ptrace) ? { ptraceScope: Number(ptrace) as 0 | 1 | 2 | 3 } : {}),
		fuse: dev,
		fuseMissing: dev ? [] : ["/dev/fuse as a character device that root can open"],
	};
}
