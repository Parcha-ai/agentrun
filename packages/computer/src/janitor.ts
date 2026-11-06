// The janitor: ends computers whose deadline has passed, for a provider whose vendor does not end them itself.
import type { ComputerProvider } from "./provider.js";
import { type ComputerError, fail, ok, type Result } from "./result.js";

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

/**
 * Deletes every computer the provider lists whose deadline has passed, or whose deadline is missing or unreadable
 * (fail closed); leaves the rest. Only for a provider that declares lifetime "janitor"; a caller runs it on a schedule.
 * A computer that cannot be deleted does not stop the sweep: the result is then an error naming it and what was deleted.
 */
export async function sweep(provider: ComputerProvider, { labels = {}, now, signal }: SweepOptions = {}): Promise<Result<Swept>> {
	const { lifetime } = provider.capabilities();
	if (lifetime !== "janitor") {
		return fail("refused", `the ${provider.id} provider declares lifetime "${lifetime}": its vendor ends its computers itself, so the janitor does not sweep them`);
	}
	if (now !== undefined && !(now instanceof Date && !Number.isNaN(now.getTime()))) return fail("invalid", "now must be a Date");
	const at = (now ?? new Date()).getTime();
	if (signal?.aborted) return fail("aborted", "the sweep was aborted before it began");
	const listed = await provider.list(labels, { signal });
	if (!listed.ok) return listed;
	const deleted: string[] = [];
	const failed: string[] = [];
	let firstError: ComputerError | undefined;
	let kept = 0;
	for (const { ref, deadline } of listed.value) {
		const time = deadline instanceof Date ? deadline.getTime() : Number.NaN;
		if (!Number.isNaN(time) && time > at) {
			kept++;
			continue;
		}
		if (signal?.aborted) return fail("aborted", `the sweep was aborted; it had deleted ${deleted.join(", ") || "none"}`);
		const released = await provider.release(ref, "delete");
		if (released.ok) deleted.push(ref.name);
		else {
			firstError ??= released.error;
			failed.push(`${ref.name}: ${released.error.message}`);
		}
	}
	if (firstError) return fail(firstError.code, `the sweep deleted ${deleted.join(", ") || "none"} but could not delete ${failed.join("; ")}`);
	return ok({ deleted, kept });
}
