// The janitor: ends computers whose deadline has passed, for a provider whose vendor does not end them itself.
import type { ComputerProvider } from "./provider.js";
import { fail, type Result } from "./result.js";

export interface SweepOptions {
	/** Only computers with all of these labels; default every computer the provider made. */
	labels?: Record<string, string>;
	/** The time to compare deadlines with; default now. */
	now?: Date;
	signal?: AbortSignal;
}

export interface Swept {
	/** The names of the computers deleted. */
	deleted: string[];
	/** How many were left, their deadline still ahead. */
	kept: number;
}

export async function sweep(_provider: ComputerProvider, _options: SweepOptions = {}): Promise<Result<Swept>> {
	return fail("unsupported", "sweep is not built yet");
}
