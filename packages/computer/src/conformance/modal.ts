// Modal for the conformance CLI: `--provider dist/conformance/modal.js`. Not built yet.
import type { ComputerProvider } from "../provider.js";

export async function createProvider(): Promise<ComputerProvider> {
	throw new Error("the Modal conformance module is not built yet");
}

export async function createDriftedProvider(): Promise<ComputerProvider> {
	throw new Error("the Modal conformance module is not built yet");
}
