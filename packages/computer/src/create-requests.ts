// Idempotent create's in-process half (spec/computer/provider.md, Idempotent create), one per provider instance and the
// same for every provider: the request id checked, the computer's name from it (computerNameFor), a second create of a
// request still in flight sharing the first's answer, and the names of the computers this provider ended, refused as
// exists once the vendor forgets them. What a vendor can still show (a machine by that name, starting, up or stopped) is
// the provider's own to read, in the make it passes.
import { isDeepStrictEqual } from "node:util";
import { type ComputerSpec, type CreateContext, type CreatedComputer, computerNameFor, requestIdProblem } from "./provider.js";
import type { ComputerErrorCode, Result } from "./result.js";

/** The most request names one provider remembers as ended, the oldest let go first: a bound, not a ledger. */
const ENDED_MAX = 4_096;

/** How a provider refuses, in its own words and with its own vendor. */
export type Refuse = (code: ComputerErrorCode, message: string) => Result<never>;

/** The words of a request whose computer has ended (provider.md). */
export const endedWords = (name: string) => `${name} was made for this request and has ended: create with a new request id`;

/** The words of a request whose computer is another spec's. */
export const otherSpecWords = (name: string, seen: "is being made" | "was made", differ: string[]) => `${name} ${seen} for this request with another spec, so it is not returned: ${differ.join("; ")}; create with a new request id`;

/** How two label sets differ, in words: each key asked with another value or none, and each key have holds that was never asked. Empty when they match. */
export function labelsDiffer(asked: Record<string, string>, have: Record<string, string>, seen: string): string[] {
	const differ = Object.entries(asked)
		.filter(([key, value]) => have[key] !== value)
		.map(([key, value]) => `label ${key}: asked ${JSON.stringify(value)}, ${seen} ${have[key] === undefined ? "nothing" : JSON.stringify(have[key])}`);
	const unasked = Object.keys(have).filter((key) => !Object.hasOwn(asked, key));
	if (unasked.length > 0) differ.push(`labels ${unasked.join(", ")}: ${seen}, never asked for`);
	return differ;
}

/**
 * How asked differs from inFlight, the spec of a create of the same request still in flight, in words: every field but
 * lifetimeMs (each create counts its own lifetime from its start), the labels exactly, and the user as the provider
 * resolves it (userOf: an unset user is the provider's default). Empty when they are the same.
 */
export function specDiffer(asked: ComputerSpec, inFlight: ComputerSpec, userOf: (spec: ComputerSpec) => string | undefined = (spec) => spec.user): string[] {
	const differ = labelsDiffer(asked.labels ?? {}, inFlight.labels ?? {}, "in flight");
	const fields = new Set([...Object.keys(asked), ...Object.keys(inFlight)] as Array<keyof ComputerSpec>);
	for (const field of fields) {
		if (field === "lifetimeMs" || field === "labels" || field === "user") continue;
		if (!isDeepStrictEqual(asked[field], inFlight[field])) differ.push(`${field}: asked ${show(asked[field])}, in flight ${show(inFlight[field])}`);
	}
	const [user, flying] = [userOf(asked), userOf(inFlight)];
	if (user !== flying) differ.push(`user: asked ${user ?? "the default"}, in flight ${flying ?? "the default"}`);
	return differ;
}

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));

export interface CreateOnce {
	refuse: Refuse;
	/** Why the provider does not serve the spec, in words, when it does not: refused once the request id is checked. */
	refused?: string;
	/** The user a spec's computer runs as, as the provider resolves it (its default for none): what specDiffer compares. */
	userOf?(spec: ComputerSpec): string | undefined;
	/** The provider's create by the request's name: it finds the computer a vendor holds under it, or makes one. */
	make(name: string): Promise<Result<CreatedComputer>>;
}

export class CreateRequests {
	readonly #creating = new Map<string, { spec: ComputerSpec; result: Promise<Result<CreatedComputer>> }>();
	readonly #ended = new Set<string>();

	/**
	 * Makes a computer once per request: a request id that is none is invalid; a create of a request already in flight
	 * waits for the first and answers what it does when it asks the same, and is refused exists when it asks another
	 * spec (specDiffer); a request whose computer this provider ended is refused exists; anything else is make's, under
	 * the name.
	 */
	async create(spec: ComputerSpec, context: CreateContext, { refuse, refused, userOf, make }: CreateOnce): Promise<Result<CreatedComputer>> {
		const problem = requestIdProblem(context?.requestId);
		if (problem !== undefined) return refuse("invalid", problem);
		if (refused !== undefined) return refuse("refused", refused);
		const name = computerNameFor(context.requestId);
		const inFlight = this.#creating.get(name);
		if (inFlight !== undefined) {
			const differs = specDiffer(spec, inFlight.spec, userOf);
			if (differs.length > 0) return refuse("exists", otherSpecWords(name, "is being made", differs));
			return inFlight.result;
		}
		if (this.#ended.has(name)) return refuse("exists", endedWords(name));
		const creating = { spec, result: make(name) };
		this.#creating.set(name, creating);
		try {
			return await creating.result;
		} finally {
			if (this.#creating.get(name) === creating) this.#creating.delete(name);
		}
	}

	/** A request's computer given up on or deleted: its name remembered, the oldest let go past ENDED_MAX. */
	end(name: string): void {
		this.#ended.delete(name);
		this.#ended.add(name);
		for (const oldest of this.#ended) {
			if (this.#ended.size <= ENDED_MAX) break;
			this.#ended.delete(oldest);
		}
	}

	/** A computer made under the name: its request is no longer ended. */
	made(name: string): void {
		this.#ended.delete(name);
	}

	/** Whether this provider ended the computer of the request with this name. */
	ended(name: string): boolean {
		return this.#ended.has(name);
	}
}
