// Runs the conformance CLI's ui cases (or the ones --only names) with this Mac's conformance module (conformance.mjs) and writes its JSON report
// with each case's time added: ms, from the end of the case before it (the first from the run's start). The runner runs
// cases one at a time, so that is the case's own time, its computer's connect included.
//
//   node ui-conformance.mjs REPORT.json [CLI options...]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../../dist/conformance/cli.js";

const [out, ...extra] = process.argv.slice(2);
if (out === undefined) {
	process.stderr.write("usage: node ui-conformance.mjs REPORT.json [CLI options...]\n");
	process.exit(2);
}
const ended = new Map();
let last = Date.now();
let json = "";
const progress = {
	write(text, done) {
		// One line per case as it ends: "✓ id", "✗ id" or "- id".
		for (const line of text.split("\n")) {
			const id = line.slice(2).trim();
			if (id === "") continue;
			const now = Date.now();
			ended.set(id, now - last);
			last = now;
		}
		process.stderr.write(text);
		done?.();
		return true;
	},
};
const stdout = {
	write(text, done) {
		json += text;
		done?.();
		return true;
	},
};
const module = fileURLToPath(new URL("./conformance.mjs", import.meta.url));
// The ui cases, unless the options name others (--only ui,input with --fixture for the input cases).
const only = extra.includes("--only") ? [] : ["--only", "ui"];
const code = await main(["--provider", module, ...only, "--json", ...extra], { stdout, stderr: progress, progress: true });
const report = JSON.parse(json);
for (const result of report.results ?? []) {
	if (ended.has(result.id)) result.ms = ended.get(result.id);
}
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.exitCode = code;
