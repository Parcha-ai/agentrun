// Every case of the suite, in the order it runs.
import type { Case } from "../types.js";
import { driftCases } from "./drift.js";
import { execCases } from "./exec.js";
import { filesCases } from "./files.js";
import { healthCases } from "./health.js";
import { processCases } from "./process.js";
import { providerCases } from "./provider.js";

export const conformanceCases: Case[] = [...healthCases, ...execCases, ...filesCases, ...processCases, ...providerCases, ...driftCases];
