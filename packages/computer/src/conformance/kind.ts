// Conformance by kind: the cases a setting kind runs, and whether a provider passes it. One table with the registry
// (src/kinds.ts): a kind's cases are those whose protocol groups it requires or allows, and a provider passes the kind
// only when it serves it and every case of each required group passes, at least one of them.
import { type ComputerSettingKind, type KindCapabilities, SETTING_KIND_NAMES, SETTING_KINDS, servingRefusals } from "../kinds.js";
import { GROUPS, type Group } from "../protocol.js";
import { conformanceCases } from "./cases/index.js";
import type { Case, ConformanceReport } from "./types.js";

/** A kind's verdict: pass, or fail with why, in words. */
export interface KindVerdict {
	kind: ComputerSettingKind;
	verdict: "pass" | "fail";
	reasons: string[];
}

const groupsOf = (c: Case): Group[] => c.needs.filter((need): need is Group => (GROUPS as readonly string[]).includes(need));

/** Why a run cannot be by this kind, in words; undefined when it can. Kind none is no computer. */
export function kindRunProblem(kind: ComputerSettingKind): string | undefined {
	const spec = Object.hasOwn(SETTING_KINDS, kind) ? SETTING_KINDS[kind] : undefined;
	if (spec === undefined) return `${JSON.stringify(kind)} is not a setting kind: ${SETTING_KIND_NAMES.join(", ")}`;
	if (spec.machineKinds.length === 0) return `kind ${kind} is no computer: there is nothing to run its cases on`;
	return undefined;
}

/**
 * The cases a kind runs: each whose protocol groups the kind requires or allows, those that need no group (health,
 * provider, drift) among them. None for kind none.
 */
export function kindCases(kind: ComputerSettingKind, cases: readonly Case[] = conformanceCases): Case[] {
	if (kindRunProblem(kind) !== undefined) return [];
	const allowed: readonly Group[] = [...SETTING_KINDS[kind].required, ...SETTING_KINDS[kind].optional];
	return cases.filter((c) => groupsOf(c).every((group) => allowed.includes(group)));
}

/**
 * Whether the provider whose capabilities these are passes the kind, by the run's report and its cases (the kind's): it
 * serves the kind; no case of the run failed (a declared optional group that fails would give a loop a broken tool);
 * for each required group, at least one case that needs it passed and no Core case was skipped but for an optional group
 * the computer does not declare; and the run left nothing behind. A Full case's skip is owed by no group: a provider may
 * refuse in words what its kind does not require (a phone's pinch), and it is still tried and reported.
 */
export function kindVerdict(kind: ComputerSettingKind, capabilities: KindCapabilities, report: ConformanceReport, cases: readonly Case[] = conformanceCases): KindVerdict {
	const problem = kindRunProblem(kind);
	if (problem !== undefined) return { kind, verdict: "fail", reasons: [problem] };
	const reasons = [...servingRefusals(capabilities, kind)];
	for (const result of report.results) if (result.status === "fail") reasons.push(`${result.id} failed: ${result.reason ?? "no reason given"}`);
	const byId = new Map(cases.map((c) => [c.id, c]));
	for (const group of SETTING_KINDS[kind].required) {
		const ofGroup = report.results.filter((result) => byId.get(result.id)?.needs.includes(group));
		for (const result of ofGroup) {
			if (result.status === "skip" && result.undeclared === undefined && byId.get(result.id)?.level === "core") reasons.push(`${result.id} was skipped: ${result.reason ?? "no reason given"}`);
		}
		if (!ofGroup.some((result) => result.status === "pass")) reasons.push(`no case of ${group} passed`);
	}
	const { left, errors } = report.cleanup;
	if (left.length > 0 || errors.length > 0) reasons.push(`the run left ${[...left, ...errors].join("; ")}`);
	return { kind, verdict: reasons.length === 0 ? "pass" : "fail", reasons: [...new Set(reasons)] };
}
