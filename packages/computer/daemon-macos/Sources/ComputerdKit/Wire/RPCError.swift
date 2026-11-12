import Foundation

/// error.data.kind: what went wrong, as a caller acts on it. The words are for a person; the kind is for code.
public enum ErrorKind: String, Sendable, Codable, CaseIterable {
	case notFound = "not_found"
	case invalid
	case timeout
	case aborted
	case denied
	case limit
	case unsupported
	case exists
	case notDir = "not_dir"
	case isDir = "is_dir"
	/// The element behind a ref is gone, or the window moved or redrew under a point.
	case stale
}

/// JSON-RPC's codes, as protocol.json lists them.
public enum RPCCode {
	public static let parse = -32700
	public static let invalidRequest = -32600
	public static let methodNotFound = -32601
	public static let invalidParams = -32602
	public static let server = -32000
	public static let requestCancelled = -32800
}

/// An error a method answers: a kind and words a person can act on. The words never hold a key, a token or a secret.
public struct RPCError: Error, Sendable, Equatable, CustomStringConvertible {
	public var kind: ErrorKind
	public var message: String
	/// Set only where the code is not the kind's own: a method the computer does not have, a line that is not JSON, a
	/// request line over the limit.
	public var code: Int?

	public init(_ kind: ErrorKind, _ message: String, code: Int? = nil) {
		self.kind = kind
		self.message = message
		self.code = code
	}

	public var description: String { "\(kind.rawValue): \(message)" }

	/// The JSON-RPC code: from the kind unless set.
	public var rpcCode: Int {
		if let code { return code }
		switch kind {
		case .invalid: return RPCCode.invalidParams
		case .aborted: return RPCCode.requestCancelled
		default: return RPCCode.server
		}
	}

	public static func invalid(_ message: String) -> RPCError { RPCError(.invalid, message) }
	public static func notFound(_ message: String) -> RPCError { RPCError(.notFound, message) }
	public static func denied(_ message: String) -> RPCError { RPCError(.denied, message) }
	public static func unsupported(_ message: String) -> RPCError { RPCError(.unsupported, message) }
	public static func stale(_ message: String) -> RPCError { RPCError(.stale, message) }
	public static func limit(_ message: String) -> RPCError { RPCError(.limit, message) }
	public static let aborted = RPCError(.aborted, "the request was cancelled")
}
