/**
 * What one exec in a new box reads, so the facts are what the box has and not what was asked: the size of the workspace's
 * filesystem in KiB, the Yama setting (a box without it reads 0), and, when `fuse` was asked for, whether `/dev/fuse` opens for a
 * user who is not root and a setuid `fusermount` exists. The workspace (`$1`) and the request (`$2`, `fuse` or `-`) come as
 * arguments, never in the text.
 */
export const PROBE = [
	'echo "disk=$(df -Pk "$1" 2>/dev/null | awk \'NR==2{print $2}\')"',
	"if [ -r /proc/sys/kernel/yama/ptrace_scope ]; then p=$(cat /proc/sys/kernel/yama/ptrace_scope); else p=0; fi",
	'echo "ptrace=$p"',
	'if [ "$2" = fuse ]; then',
	"  dev=0",
	"  if [ -c /dev/fuse ] && command -v setpriv >/dev/null 2>&1 && setpriv --reuid=65534 --regid=65534 --clear-groups sh -c 'exec 3<>/dev/fuse' 2>/dev/null; then dev=1; fi",
	"  helper=0",
	// Each name as a program would run it (the first on the PATH): one working helper is enough, whichever the other is.
	"  for n in fusermount3 fusermount; do",
	'    h=$(command -v "$n" 2>/dev/null)',
	'    if [ -n "$h" ] && [ -u "$h" ]; then helper=1; fi',
	"  done",
	'  echo "fuse_dev=$dev"; echo "fuse_helper=$helper"',
	"fi",
].join("\n");

/** What the probe's output says. A fact the box did not give is left out. */
export type ProbeReading = {
	readonly diskGb?: number;
	readonly ptraceScope?: 0 | 1 | 2 | 3;
	/** `true` only when `/dev/fuse` opens for an unprivileged user and a setuid `fusermount` exists. */
	readonly fuse: boolean;
	/** What FUSE lacks, in words, when it lacks something. */
	readonly fuseMissing: readonly string[];
};

export function parseProbe(output: string): ProbeReading {
	const read = new Map(output.split("\n").map((line) => line.split("=") as [string, string]));
	const kib = Number(read.get("disk"));
	const ptrace = read.get("ptrace");
	const dev = read.get("fuse_dev") === "1";
	const helper = read.get("fuse_helper") === "1";
	return {
		...(read.get("disk") !== undefined && read.get("disk") !== "" && Number.isFinite(kib) && kib > 0
			? { diskGb: Math.floor(kib / (1024 * 1024)) }
			: {}),
		...(ptrace !== undefined && /^[0-3]$/.test(ptrace) ? { ptraceScope: Number(ptrace) as 0 | 1 | 2 | 3 } : {}),
		fuse: dev && helper,
		fuseMissing: [
			dev ? "" : "/dev/fuse openable by a user who is not root (and setpriv)",
			helper ? "" : "a setuid fusermount",
		].filter(Boolean),
	};
}
