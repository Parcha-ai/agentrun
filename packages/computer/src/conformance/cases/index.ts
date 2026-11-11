// Every case of the suite, in the order it runs.
import type { ComputerKind } from "../../protocol.js";
import type { Case } from "../types.js";
import { appsCases } from "./apps.js";
import { browserCases } from "./browser.js";
import { driftCases } from "./drift.js";
import { execCases } from "./exec.js";
import { filesCases } from "./files.js";
import { gpuCases } from "./gpu.js";
import { healthCases } from "./health.js";
import { inputCases } from "./input.js";
import { isolationCases } from "./isolation.js";
import { lifetimeCases } from "./lifetime.js";
import { mountCases } from "./mount.js";
import { processCases } from "./process.js";
import { providerCases } from "./provider.js";
import { screenCases } from "./screen.js";
import { touchCases } from "./touch.js";

export { browserCases, browserOnlyCases } from "./browser.js";

export const conformanceCases: Case[] = [
	...healthCases,
	...execCases,
	...filesCases,
	...processCases,
	...providerCases,
	...driftCases,
	...isolationCases,
	...mountCases,
	...screenCases,
	...inputCases,
	...touchCases,
	...appsCases,
	...lifetimeCases,
	...gpuCases,
];

/**
 * The cases a run takes when it is given none, by the machine kind of the computer: a browser's own (health, then the
 * browser cases, which keep one browser for the run), every other kind the suite's. The CLI and runConformance agree.
 */
export function casesFor(machineKind: ComputerKind | undefined): Case[] {
	return machineKind === "browser" ? browserCases : conformanceCases;
}
