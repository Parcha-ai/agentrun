import Foundation

/// One method's handler: its params as sent, its result as JSON.
public typealias Handler = @Sendable (JSON?) async throws -> JSON

/// The method table a connection serves.
public struct Router: Sendable {
	private(set) var handlers: [String: Handler] = [:]

	public init() {}

	/// A method whose params are read strictly into P.
	public mutating func on<P: Codable & Sendable, R: Encodable & Sendable>(
		_ method: String, _ params: P.Type, _ body: @escaping @Sendable (P) async throws -> R
	) {
		handlers[method] = { raw in
			let p = try Params.decode(P.self, raw, method: method)
			return try Coders.json(try await body(p))
		}
	}

	/// A method that takes any params and reads none: hello and ping, so a newer client is never refused.
	public mutating func onAny<R: Encodable & Sendable>(_ method: String, _ body: @escaping @Sendable () async throws -> R) {
		handlers[method] = { _ in try Coders.json(try await body()) }
	}

	public var methods: [String] { handlers.keys.sorted() }

	public func handler(_ method: String) -> Handler? { handlers[method] }
}
