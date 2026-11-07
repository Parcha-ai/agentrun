// Every case of the suite, in the order it runs.
import type { Case } from "../types.js";
import { appsCases } from "./apps.js";
import { driftCases } from "./drift.js";
import { execCases } from "./exec.js";
import { filesCases } from "./files.js";
import { healthCases } from "./health.js";
import { inputCases } from "./input.js";
import { lifetimeCases } from "./lifetime.js";
import { processCases } from "./process.js";
import { providerCases } from "./provider.js";
import { screenCases } from "./screen.js";
import { touchCases } from "./touch.js";

export const conformanceCases: Case[] = [
	...healthCases,
	...execCases,
	...filesCases,
	...processCases,
	...providerCases,
	...driftCases,
	...screenCases,
	...inputCases,
	...touchCases,
	...appsCases,
	...lifetimeCases,
];
