// Preloaded (node --require) into a fake docker program by fake-docker.test.mjs. The program's one append to the file
// whose name is TORN_APPEND lands in two parts, as a reader sees a write in flight that crosses a page: its first
// TORN_APPEND_AT bytes, then, once the file TORN_APPEND_GO is there, the rest. "held" on stderr says the first part is in.
const fs = require("node:fs");
const { basename } = require("node:path");

const append = fs.appendFileSync;
fs.appendFileSync = function (file, data, ...rest) {
	if (typeof file !== "string" || basename(file) !== process.env.TORN_APPEND) return append.call(this, file, data, ...rest);
	const bytes = Buffer.from(data);
	const at = Number(process.env.TORN_APPEND_AT);
	append(file, bytes.subarray(0, at));
	process.stderr.write("held\n");
	while (!fs.existsSync(process.env.TORN_APPEND_GO)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	append(file, bytes.subarray(at));
};
