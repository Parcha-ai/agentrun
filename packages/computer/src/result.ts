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
	| "docker";

export interface ComputerError {
	code: ComputerErrorCode;
	message: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = (code: ComputerErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
