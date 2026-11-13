package ai.agentrun.phoned;

/**
 * A refusal with the protocol's kind and words a person can act on. Every handler throws one of these; the wire turns
 * it into a JSON-RPC error with the kind in data and the code that follows from the kind (spec/computer/wire.md).
 */
public final class RpcError extends RuntimeException {
	public static final int PARSE = -32700;
	public static final int INVALID_REQUEST = -32600;
	public static final int METHOD_NOT_FOUND = -32601;
	public static final int INVALID_PARAMS = -32602;
	public static final int SERVER = -32000;
	public static final int CANCELLED = -32800;

	public final String kind;
	public final int code;

	public RpcError(String kind, int code, String message) {
		super(message);
		this.kind = kind;
		this.code = code;
	}

	public RpcError(String kind, String message) {
		this(kind, codeOf(kind), message);
	}

	/** The JSON-RPC code a kind maps to when nothing more specific applies. */
	static int codeOf(String kind) {
		switch (kind) {
			case "invalid":
				return INVALID_PARAMS;
			case "aborted":
				return CANCELLED;
			default:
				return SERVER;
		}
	}

	public static RpcError invalid(String message) {
		return new RpcError("invalid", message);
	}

	public static RpcError unsupported(String message) {
		return new RpcError("unsupported", message);
	}

	public static RpcError denied(String message) {
		return new RpcError("denied", message);
	}

	public static RpcError notFound(String message) {
		return new RpcError("not_found", message);
	}

	public static RpcError stale(String message) {
		return new RpcError("stale", message);
	}

	public static RpcError aborted(String message) {
		return new RpcError("aborted", message);
	}

	public static RpcError timeout(String message) {
		return new RpcError("timeout", message);
	}

	public static RpcError limit(String message) {
		return new RpcError("limit", message);
	}
}
