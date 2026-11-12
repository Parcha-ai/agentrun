import Foundation

/// The attach binding's settings: the driver dials url (wss://<serve>/v2/computers/attach) with the pairing token, and
/// speaks the same JSON-RPC lines as WebSocket text frames. Kept in Paths.attach, mode 0600; the token is never logged.
public struct AttachSettings: Sendable, Codable, Equatable {
	/// The LaunchAgent's label: `launchctl kickstart -k gui/<uid>/<label>` restarts the app.
	public static let agentLabel = "ai.parcha.computerd"

	public var url: String
	public var token: String

	public init(url: String, token: String) {
		self.url = url
		self.token = token
	}

	public static func load(_ path: String = Paths.attach) -> AttachSettings? {
		guard let data = FileManager.default.contents(atPath: path) else { return nil }
		return try? JSONDecoder().decode(AttachSettings.self, from: data)
	}

	public func save(_ path: String = Paths.attach) throws {
		let dir = (path as NSString).deletingLastPathComponent
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		let data = try Coders.encode(self)
		guard FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600]) else {
			throw RPCError.denied("cannot write \(path)")
		}
	}
}

extension Policy {
	/// The policy file, or the default (any app) when there is none.
	public static func load(_ path: String = Paths.policy) throws -> Policy {
		guard let data = FileManager.default.contents(atPath: path) else { return Policy() }
		do {
			return try JSONDecoder().decode(Policy.self, from: data)
		} catch {
			throw RPCError.invalid("\(path) is not a policy: \(error)")
		}
	}
}
