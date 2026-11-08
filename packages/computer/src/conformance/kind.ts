// Conformance by kind: the cases a kind runs, and whether a provider passes it. One table with the registry
// (src/kinds.ts): a kind's cases are those whose protocol groups it requires or allows, and a provider passes the kind
// only when it serves it and every case of each required group passes, at least one of them.
import { KIND_SPECS, type Kind, type KindCapabilities, KINDS, servingRefusals } from "../kinds.js";
import { GROUPS, type Group } from "../protocol.js";
import { conformanceCases } from "./cases/index.js";
import type { Case, ConformanceReport } from "./types.js";

/** A kind's verdict: pass, or fail with why, in words. */
export interface KindVerdict {
	kind: Kind;
	verdict: "pass" | "fail";
	reasons: string[];
}

const groupsOf = (c: Case): Group[] => c.needs.filter((need): need is Group => (GROUPS as readonly string[]).includes(need));

/** Why a run cannot be by this kind, in words; undefined when it can. */
export function kindRunProblem(kind: Kind): string | undefined {
	const spec = KIND_SPECS[kind];
	if (spec === undefined) return `${JSON.stringify(kind)} is not a kind: ${KINDS.join(", ")}`;
	if (spec.plane === "none") return "kind none is no computer: there is nothing to run its cases on";
	if (spec.plane === "cdp") return "kind browser answers CDP, and the suite has no CDP cases yet";
	return undefined;
}

/**
 * The cases a kind runs: each whose protocol groups the kind requires or allows, those that need no group (health,
 * provider, drift) among them. None for a kind with no computerd plane (none, browser).
 */
export function kindCases(kind: Kind, cases: readonly Case[] = conformanceCases): Case[] {
	if (kindRunProblem(kind) !== undefined) return [];
	const allowed: readonly Group[] = [...KIND_SPECS[kind].required, ...KIND_SPECS[kind].optional];
	return cases.filter((c) => groupsOf(c).every((group) => allowed.includes(group)));
}

/**
 * Whether the provider whose capabilities these are passes the kind, by the run's report and its cases (the kind's): it
 * serves the kind; no case of the run failed (a declared optional group that fails would give a loop a broken tool);
 * for each required group, at least one case that needs it passed and none was skipped but for an optional group the
 * computer does not declare; and the run left nothing behind.
 */
export function kindVerdict(kind: Kind, capabilities: KindCapabilities, report: ConformanceReport, cases: readonly Case[] = conformanceCases): KindVerdict {
	const problem = kindRunProblem(kind);
	if (problem !== undefined) return { kind, verdict: "fail", reasons: [problem] };
	const reasons = [...servingRefusals(capabilities, kind)];
	for (const result of report.results) if (result.status === "fail") reasons.push(`${result.id} failed: ${result.reason ?? "no reason given"}`);
	const byId = new Map(cases.map((c) => [c.id, c]));
	for (const group of KIND_SPECS[kind].required) {
		const ofGroup = report.results.filter((result) => byId.get(result.id)?.needs.includes(group));
		for (const result of ofGroup) {
			if (result.status === "skip" && result.undeclared === undefined) reasons.push(`${result.id} was skipped: ${result.reason ?? "no reason given"}`);
		}
		if (!ofGroup.some((result) => result.status === "pass")) reasons.push(`no case of ${group} passed`);
	}
	const { left, errors } = report.cleanup;
	if (left.length > 0 || errors.length > 0) reasons.push(`the run left ${[...left, ...errors].join("; ")}`);
	return { kind, verdict: reasons.length === 0 ? "pass" : "fail", reasons: [...new Set(reasons)] };
}
