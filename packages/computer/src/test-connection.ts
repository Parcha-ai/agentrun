// Settings' "test connection" (ComputerProvider.testConnection): what each provider's one account-level read means, in
// the same words. A key the vendor refused is unauthorized and a vendor not reached in time unreachable; any other
// error keeps its code. A message is the provider's own, which never carries a key.
import { type ComputerError, ok, type Result } from "./result.js";

/** An error of the read, as testConnection answers it. */
export function connectionError(error: ComputerError): ComputerError {
	if (error.code === "denied") return { code: "unauthorized", message: error.message };
	if (error.code === "timeout") return { code: "unreachable", message: error.message };
	return error;
}

/**
 * One listing by the provider's own label, as testConnection answers it: how many computers of this provider it found,
 * "or more" when the vendor has another page the test did not read.
 */
export function countTested(vendor: string, counted: Result<{ count: number; more?: boolean }>): Result<{ detail: string }> {
	if (!counted.ok) return { ok: false, error: connectionError(counted.error) };
	const { count, more = false } = counted.value;
	return ok({ detail: `${vendor} answered: ${count}${more ? " or more" : ""} ${count === 1 && !more ? "computer" : "computers"} of this provider` });
}

/** A list by the provider's own label, as testConnection answers it: how many computers of this provider it found. */
export function listTested(vendor: string, listed: Result<readonly unknown[]>): Result<{ detail: string }> {
	return countTested(vendor, listed.ok ? ok({ count: listed.value.length }) : listed);
}
