// Settings' "test connection" (ComputerProvider.testConnection): what each provider's one account-level read means, in
// the same words. A key the vendor refused is unauthorized and a vendor not reached in time unreachable; any other
// error keeps its code. A message is the provider's own, which never carries a key.
import { type ComputerError, fail, ok, type Result } from "./result.js";

/** An error of the read, as testConnection answers it. */
export function connectionError(error: ComputerError): ComputerError {
	if (error.code === "denied") return { code: "unauthorized", message: error.message };
	if (error.code === "timeout") return { code: "unreachable", message: error.message };
	return error;
}

/** A list by the provider's own label, as testConnection answers it: how many computers of this provider it found. */
export function listTested(vendor: string, listed: Result<readonly unknown[]>): Result<{ detail: string }> {
	if (!listed.ok) return fail(connectionError(listed.error).code, connectionError(listed.error).message);
	const n = listed.value.length;
	return ok({ detail: `${vendor} answered: ${n} ${n === 1 ? "computer" : "computers"} of this provider` });
}
