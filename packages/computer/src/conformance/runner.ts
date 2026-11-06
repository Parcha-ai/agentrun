// The runner: runs each case against a provider and ends every computer it made.
import type { ComputerProvider } from "../provider.js";
import type { ConformanceOptions, ConformanceReport } from "./types.js";

export async function runConformance(_provider: ComputerProvider, _options: ConformanceOptions): Promise<ConformanceReport> {
	throw new Error("runConformance is not built yet");
}
