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
	| "docker"
	| "daytona"
	| "modal"
	| "e2b"
	| "phone";

export interface ComputerError {
	code: ComputerErrorCode;
	message: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = (code: ComputerErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
