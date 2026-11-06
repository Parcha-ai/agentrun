// Docker for the suite: the provider with the daemon for Docker's architecture, and one with a daemon of another version.
import type { ComputerProvider } from "../provider.js";

export interface DockerConformance {
	provider: ComputerProvider;
	drifted: () => Promise<ComputerProvider>;
}

export function dockerConformance(): DockerConformance {
	throw new Error("dockerConformance is not built yet");
}
