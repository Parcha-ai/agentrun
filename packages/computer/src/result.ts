/** An expected outcome: a value, or an error in words. Expected failures are results, not throws. */
export type Result<T, E = ComputerError> = { ok: true; value: T } | { ok: false; error: E };

export type ComputerErrorCode =
	| "gone"
	| "refused"
	| "timeout"
	| "aborted"
	| "not_found"
	| "invalid"
	| "unsupported"
	| "denied"
	| "limit"
	| "exists"
	| "not_dir"
	| "is_dir"
	// testConnection's: a key the vendor refused, and a vendor not reached.
	| "unauthorized"
	| "unreachable"
	// The vendor answered with a failure of its own (its API, its CLI, its device): `vendor` names which.
	| "vendor";

export interface ComputerError {
	code: ComputerErrorCode;
	message: string;
	/** With code vendor: the provider whose vendor failed (docker, daytona, ...), its descriptor's id. */
	vendor?: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = (code: ComputerErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
/** A failure the vendor answered with: code vendor, the vendor named by its provider's id. */
export const vendorFail = (vendor: string, message: string): Result<never> => ({ ok: false, error: { code: "vendor", vendor, message } });
/** An error of a code a provider computed: with code vendor, vendor names it. */
export const errorOf = (code: ComputerErrorCode, message: string, vendor: string): ComputerError => (code === "vendor" ? { code, vendor, message } : { code, message });
/** A provider module's fail: an error with code vendor names `vendor`, the provider's id. */
export const failFor =
	(vendor: string) =>
	(code: ComputerErrorCode, message: string): Result<never> => ({ ok: false, error: errorOf(code, message, vendor) });
/** `error` passed up in new words: its code kept (or `code`), and while the code is vendor, its vendor with it. */
export const failAs = (error: ComputerError, message: string, code: ComputerErrorCode = error.code): Result<never> => ({
	ok: false,
	error: code === "vendor" && error.vendor !== undefined ? { code, vendor: error.vendor, message } : { code, message },
});
