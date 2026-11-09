// /proc/<pid>/net/dev as the kernel writes it, for the fakes whose daemon reads its own: two header lines, then one
// line per interface of the reader's network namespace.
export function netDevText(names = ["lo"]) {
	const zeros = "       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0";
	return [
		"Inter-|   Receive                                                |  Transmit",
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
		...names.map((name) => `${name.padStart(6)}:${zeros}`),
		"",
	].join("\n");
}
