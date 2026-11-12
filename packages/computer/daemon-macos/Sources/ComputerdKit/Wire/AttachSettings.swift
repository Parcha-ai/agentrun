import Foundation

/// The attach binding (spec/computer/attach.md): the driver dials wss://<server>/v2/computers/attach with its token in
/// the upgrade's Authorization header and the subprotocol of the version it speaks, and answers the server's JSON-RPC
/// messages, one per text frame. The server is the caller.
public enum Attach {
	public static let path = "/v2/computers/attach"
	public static let pairPath = "/v2/computers/pair"
	public static var subprotocol: String { "agentrun.computer.\(protocolVersion)" }
	/// Each side pings this often, so a NAT keeps the path open.
	public static let heartbeatMs = 20_000
	/// Nothing heard for this long (not a message, not a pong) closes the socket with Close.idle.
	public static let idleMs = 60_000
	/// The longest a driver waits between two dials.
	public static let redialMaxMs = 60_000
	/// A socket up this long resets the redial count.
	public static let steadyMs = 60_000
	/// A pairing code: eight characters with no 0, O, 1 or I, "K7PD-W3QX".
	public static let codeAlphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

	/// Why a socket closed.
	public enum Close {
		public static let normal = 1000
		public static let going = 1001
		public static let binary = 1003
		public static let tooBig = 1009
		/// The computer's hello is not what it paired as: pair again.
		public static let mismatch = 4400
		/// The token is unknown or was revoked: pair again.
		public static let unauthorized = 4401
		public static let idle = 4408
		/// The same computer dialed again; the older socket is closed.
		public static let replaced = 4409
		/// The driver speaks another protocol version: update it.
		public static let `protocol` = 4426
	}

	/// What a person must do after a close with this code, or nil when the driver dials again.
	public static func stop(_ code: Int) -> String? {
		switch code {
		case Close.mismatch: return "the server says this Mac is not what it paired as: pair it again"
		case Close.unauthorized: return "the server does not know this Mac's token, or it was revoked: pair it again"
		case Close.protocol: return "the server speaks another protocol version than Computerd \(driverVersion) (\(protocolVersion)): update Computerd"
		default: return nil
		}
	}

	/// How long to wait before redial number attempt (from 0): 1 s doubling to redialMaxMs, less up to a fifth at
	/// random so a fleet that lost the server together does not come back together.
	public static func redialDelayMs(_ attempt: Int, random: Double = Double.random(in: 0..<1)) -> Int {
		let doubled = 1000 * Double(1 << max(0, min(attempt, 16)))
		let base = min(Double(redialMaxMs), doubled)
		return Int((base * (1 - random / 5)).rounded())
	}

	/// A code as a person typed it, made canonical: upper case, the dash put in. Nil when it is not a pairing code.
	public static func pairingCode(_ typed: String) -> String? {
		let letters = typed.uppercased().filter { $0 != "-" && $0 != " " }
		guard letters.count == 8, letters.allSatisfy(codeAlphabet.contains) else { return nil }
		return "\(letters.prefix(4))-\(letters.suffix(4))"
	}
}

/// What a driver sends to trade a pairing code for its computer's token: POST /v2/computers/pair.
public struct PairRequest: Sendable, Codable, Equatable {
	public var code: String
	/// What the person calls the machine.
	public var name: String
	/// The driver's hello, so the server knows what it pairs.
	public var hello: HelloResult

	public init(code: String, name: String, hello: HelloResult) {
		self.code = code
		self.name = name
		self.hello = hello
	}
}

/// The server's answer: the computer's id, and its token, which the driver keeps in the keychain.
public struct PairResult: Sendable, Codable, Equatable {
	public var computer: String
	public var token: String

	public init(computer: String, token: String) {
		self.computer = computer
		self.token = token
	}
}

/// Which server this Mac is paired with, kept in Paths.attach. The token is not here: it is in the keychain.
public struct AttachSettings: Sendable, Codable, Equatable {
	/// The LaunchAgent's label: `launchctl kickstart -k gui/<uid>/<label>` restarts the app.
	public static let agentLabel = "ai.parcha.computerd"

	/// The server's base URL: https://agentrun.example.
	public var server: String
	/// The id the server gave this computer when it paired.
	public var computer: String

	public init(server: String, computer: String) {
		self.server = server
		self.computer = computer
	}

	/// A server's base URL, checked: http or https, a host, no query. Plain http only for this machine itself.
	public static func base(_ text: String) throws -> URL {
		guard var parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(), let host = parts.host, !host.isEmpty else {
			throw RPCError.invalid("\(text) is not a server URL: give it as https://<server>")
		}
		guard scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else {
			throw RPCError.invalid("\(text): a server is reached over https (plain http only on this machine)")
		}
		guard parts.query == nil, parts.fragment == nil else { throw RPCError.invalid("\(text): a server URL has no query") }
		while parts.path.hasSuffix("/") { parts.path.removeLast() }
		guard let url = parts.url else { throw RPCError.invalid("\(text) is not a URL") }
		return url
	}

	/// Where the computer dials: the server's attach path, over wss (ws for a server on this machine).
	public func attachURL() throws -> URL {
		var parts = URLComponents(url: try Self.base(server), resolvingAgainstBaseURL: false)!
		parts.scheme = parts.scheme == "https" ? "wss" : "ws"
		parts.path += Attach.path
		return parts.url!
	}

	public static func pairURL(_ server: String) throws -> URL {
		try base(server).appendingPathComponent(String(Attach.pairPath.dropFirst()))
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
