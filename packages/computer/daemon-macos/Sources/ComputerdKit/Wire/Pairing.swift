import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// The local control calls: methods the app serves on its own unix socket only, never over attach. The command line
/// and the window hand the app work that needs its login session: pairing, whose token goes into the user's keychain,
/// which a process started over SSH cannot write ("User interaction is not allowed").
public enum Control {
	/// computerd.pair {server, code, name?} -> the AttachSettings kept. The app then dials the server.
	public static let pair = "computerd.pair"
	/// computerd.unpair {} -> {}: the token and the server forgotten, the socket to it closed.
	public static let unpair = "computerd.unpair"
}

/// computerd.pair's params: the server's URL, the code its console shows, and what to call this Mac there.
public struct PairParams: Sendable, Codable, Equatable {
	public var server: String
	public var code: String
	public var name: String?

	public init(server: String, code: String, name: String? = nil) {
		self.server = server
		self.code = code
		self.name = name
	}
}

/// Trades the code a server's console shows for this computer's id and token (POST /v2/computers/pair), keeps the
/// token and the server. Runs in the app that serves the socket, which owns the keychain; post and keep are the
/// platform's.
public struct Pairer: Sendable {
	/// POSTs a JSON body; answers the HTTP status and body.
	public var post: @Sendable (URL, Data) async throws -> (status: Int, body: Data)
	/// Keeps the token for the computer id.
	public var keep: @Sendable (_ token: String, _ computer: String) throws -> Void
	/// Where the settings go: Paths.attach.
	public var settingsPath: String

	public init(post: @escaping @Sendable (URL, Data) async throws -> (status: Int, body: Data), keep: @escaping @Sendable (String, String) throws -> Void, settingsPath: String = Paths.attach) {
		self.post = post
		self.keep = keep
		self.settingsPath = settingsPath
	}

	/// name: what to call this Mac when the params name nothing. Once the server answered 200 or 201 it has spent the
	/// code and recorded the computer: a token that cannot be kept then is said so, with what the person does next.
	public func pair(_ p: PairParams, name defaultName: String, hello: HelloResult) async throws -> AttachSettings {
		guard let code = Attach.pairingCode(p.code) else {
			throw RPCError.invalid("\(p.code) is not a pairing code: it is eight letters and digits, as K7PD-W3QX")
		}
		let base = try AttachSettings.base(p.server)
		let name = p.name ?? defaultName
		let (status, data) = try await post(try AttachSettings.pairURL(p.server), try Coders.encode(PairRequest(code: code, name: name, hello: hello)))
		guard status == 200 || status == 201 else {
			throw RPCError.denied("\(base.absoluteString) refused the code (\(status)): \(Self.words(data))")
		}
		let result: PairResult
		do {
			result = try JSONDecoder().decode(PairResult.self, from: data)
		} catch {
			throw RPCError.invalid("\(base.absoluteString)'s answer is not a pairing: \(error)")
		}
		let settings = AttachSettings(server: base.absoluteString, computer: result.computer)
		do {
			try keep(result.token, result.computer)
			try settings.save(settingsPath)
		} catch {
			let why = (error as? RPCError)?.message ?? "\(error)"
			throw RPCError.denied("\(base.absoluteString) paired this Mac as \(name), but its token could not be kept (\(why)): remove \(name) in the console's Computers page and pair again")
		}
		return settings
	}

	/// A server's error body in words: its message when it is JSON with one, else its first 300 characters.
	public static func words(_ data: Data) -> String {
		if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			if let message = object["message"] as? String { return message }
			if let error = object["error"] as? [String: Any], let message = error["message"] as? String { return message }
			if let error = object["error"] as? String { return error }
		}
		return String(String(decoding: data, as: UTF8.self).prefix(300))
	}
}

/// One JSON-RPC call on the app's socket, for the command line and the window: its result, or the app's error as an
/// RPCError of the same kind.
public enum LocalCall {
	public static func call(_ method: String, _ params: JSON? = nil, path: String = Paths.socket) throws -> JSON {
		let fd = try UnixSocket.connect(path)
		defer { sysClose(fd) }
		var request: [String: JSON] = ["jsonrpc": .string("2.0"), "id": .int(1), "method": .string(method)]
		if let params { request["params"] = params }
		guard FDOutput.writeAll(fd, try Coders.encode(JSON.object(request)) + Data([10])) else {
			throw RPCError.invalid("Computerd closed its socket before \(method) was sent")
		}
		var reply = Data()
		var buffer = [UInt8](repeating: 0, count: 64 * 1024)
		while !reply.contains(10) {
			let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
			if n < 0 && errno == EINTR { continue }
			if n <= 0 { break }
			reply.append(contentsOf: buffer[0..<n])
		}
		struct Reply: Decodable {
			struct Failure: Decodable {
				struct Kind: Decodable { var kind: ErrorKind? }
				var message: String
				var data: Kind?
			}
			var result: JSON?
			var error: Failure?
		}
		let line = reply.split(separator: 10).first.map { Data($0) } ?? Data()
		guard let decoded = try? JSONDecoder().decode(Reply.self, from: line) else {
			throw RPCError.invalid("Computerd sent no reply to \(method)")
		}
		if let error = decoded.error { throw RPCError(error.data?.kind ?? .invalid, error.message) }
		return decoded.result ?? .null
	}
}
