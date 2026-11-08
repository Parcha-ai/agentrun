// The report as a person reads it: one line per level and group, each failure and skip under its line, the Core cases
// --only left out, the verdict last.
import type { CaseGroup, CaseResult, ConformanceReport } from "./types.js";

const GROUPS: CaseGroup[] = ["health", "exec", "files", "process", "provider", "drift", "isolation", "mount", "screen", "input", "touch", "apps", "lifetime"];
const NAMES_WIDTH = 44;
const INDENT = " ".repeat("core ".length + "provider ".length + 1);

/** The case names, wrapped to the column's width: the first line, then the rest. */
function wrap(names: string[]): string[] {
	const lines: string[] = [];
	for (const name of names) {
		const last = lines.at(-1);
		if (last !== undefined && last.length + 1 + name.length <= NAMES_WIDTH) lines[lines.length - 1] = `${last} ${name}`;
		else lines.push(name);
	}
	return lines;
}

export function formatReport(report: ConformanceReport): string {
	const { daemon, results, cleanup } = report;
	const answers = report.daemonMode === "none" ? "the provider" : "computerd";
	const reached = daemon ? `${answers} ${daemon.version} ${daemon.os}/${daemon.arch}` : report.daemonMode === "none" ? "no computer reached" : "no daemon reached";
	const lines = [`computer conformance · ${report.provider} · ${report.kind}, daemon ${report.daemonMode} · ${reached}`];
	// A Core case skipped for an optional group the computer does not declare is not Core for this kind of computer (a
	// linux computer is never held to screen): it is listed as optional, out of Core's lines and count.
	const optional = (r: CaseResult) => r.status === "skip" && r.undeclared !== undefined;
	const levelOf = (r: CaseResult) => (r.level === "core" && optional(r) ? "optional" : r.level);
	for (const level of ["core", "full", "optional"] as const) {
		for (const group of GROUPS) {
			const here = results.filter((r) => levelOf(r) === level && r.group === group);
			if (here.length === 0) continue;
			const count = (status: CaseResult["status"]) => here.filter((r) => r.status === status).length;
			const counts = [
				count("pass") > 0 ? `✓ ${count("pass")}` : "",
				count("fail") > 0 ? `✗ ${count("fail")}` : "",
				count("skip") > 0 ? `- ${count("skip")}` : "",
			]
				.filter(Boolean)
				.join(" ");
			const [first = "", ...rest] = wrap(here.map((r) => r.id.slice(group.length + 1)));
			lines.push(`${level} ${group.padEnd(9)} ${first.padEnd(NAMES_WIDTH)} ${counts}`, ...rest.map((more) => `${INDENT}${more}`));
			for (const r of here) if (r.status !== "pass") lines.push(`  ${r.status === "fail" ? "✗" : "-"} ${r.id}: ${r.reason ?? ""}`);
		}
	}
	if (cleanup.late.length > 0) lines.push(`cleanup - deleted after their case ended: ${cleanup.late.join(", ")}`);
	if (cleanup.left.length > 0 || cleanup.errors.length > 0) {
		lines.push(`cleanup ✗ ${cleanup.left.length > 0 ? `left ${cleanup.left.join(", ")}` : "could not show nothing was left"}`);
		for (const error of cleanup.errors) lines.push(`  ✗ ${error}`);
	}
	const notRun = report.coreNotRun ?? [];
	if (notRun.length > 0) {
		const [first = "", ...rest] = wrap(notRun);
		lines.push(`core ${"not run".padEnd(9)} ${first}`, ...rest.map((more) => `${INDENT}${more}`));
	}
	for (const note of report.notes ?? []) lines.push(`note: ${note}`);
	for (const { computer, note } of report.computerNotes ?? []) lines.push(`note ${computer}: ${note}`);
	// What a provider said through onNote, such as a release whose final sync or checkin did not go cleanly.
	for (const { computer, note } of report.providerNotes ?? []) lines.push(`provider note ${computer}: ${note}`);
	const core = results.filter((r) => levelOf(r) === "core");
	const notDeclared = results.filter((r) => levelOf(r) === "optional").length;
	const full = results.filter((r) => r.level === "full");
	const passed = (rs: CaseResult[]) => rs.filter((r) => r.status === "pass").length;
	// A run that left Core cases out has no Core verdict: PARTIAL, never PASS.
	let verdict = `core ${report.core.toUpperCase()} ${passed(core)}/${core.length}`;
	if (notDeclared > 0) verdict += ` · ${notDeclared} optional ${notDeclared === 1 ? "case" : "cases"} skipped, not declared`;
	if (notRun.length > 0) verdict += ` · ${notRun.length} Core ${notRun.length === 1 ? "case" : "cases"} not run`;
	verdict += full.length > 0 ? ` · full ${passed(full)}/${full.length}` : " · full: none run";
	if (report.undeclared.length > 0) verdict += ` · ${report.undeclared.join(" ")} not declared`;
	if (report.only) verdict += ` · only ${report.only.join(",")}`;
	lines.push(verdict);
	return `${lines.join("\n")}\n`;
}
