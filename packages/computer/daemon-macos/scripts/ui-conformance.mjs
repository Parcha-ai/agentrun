// CI and the Mac mini's bootstrap: the protocol's health, ui and input conformance cases
// against the running Computerd, through its computerd command, with this Mac's conformance module (conformance.mjs)
// and the ui fixture app (UIFixture.app, also the desktop input fixture) when it is installed. Needs packages/computer
// built. Writes the CLI's JSON report to /tmp/computerd-ci/ui-conformance.json with each case's time added (ms, from
// the end of the case before it; the runner runs cases one at a time), prints each case, and appends the table to
// $GITHUB_STEP_SUMMARY. The run is partial (--only), so the CLI's exit code is no verdict here: this fails when a case
// fails, and a skip is reported with its reason.
//
//   node ui-conformance.mjs PATH/TO/computerd COMPUTERD_HOME
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../../dist/conformance/cli.js";

const [command, home] = process.argv.slice(2);
if (command === undefined || home === undefined) {
	process.stderr.write("usage: node ui-conformance.mjs PATH/TO/computerd COMPUTERD_HOME\n");
	process.exit(2);
}
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
process.env.COMPUTERD = command;
process.env.COMPUTERD_HOME = home;
const out = "/tmp/computerd-ci/ui-conformance.json";
mkdirSync("/tmp/computerd-ci", { recursive: true });
const fixture = "/Applications/UIFixture.app";
// Two passes: the input cases launch their own instance of the fixture (--input-log), and a ui case launched right after
// one never saw the fixture come to the front on the runner, so the ui cases go first.
const passes = [["--only", "health,ui"], ...(existsSync(fixture) ? [["--only", "input", "--fixture", fixture]] : [])];
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
const results = [];
let report = {};
for (const options of passes) {
	json = "";
	await main(["--provider", module, ...options, "--json"], { stdout, stderr: progress, progress: true });
	report = JSON.parse(json);
	results.push(...(report.results ?? []));
}
report = { ...report, results };
for (const result of results) {
	if (ended.has(result.id)) result.ms = ended.get(result.id);
}
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

const marks = { pass: "✅", fail: "❌", skip: "⏭️" };
const lines = ["| | Case | Level | ms | Detail |", "| --- | --- | --- | ---: | --- |"];
for (const r of results) {
	const detail = (r.reason ?? r.error ?? r.message ?? "").replaceAll("|", "/").replaceAll("\n", " ");
	console.log(`${r.status.toUpperCase().padEnd(5)} ${r.id} (${r.level}, ${r.ms ?? ""} ms): ${detail}`);
	lines.push(`| ${marks[r.status] ?? r.status} | ${r.id} | ${r.level} | ${r.ms ?? ""} | ${detail.slice(0, 400)} |`);
}
const count = (status) => results.filter((r) => r.status === status).length;
const total = `conformance: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`;
console.log(total);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${total}\n\n${lines.join("\n")}\n`);
process.exitCode = count("fail") > 0 || results.length === 0 ? 1 : 0;
