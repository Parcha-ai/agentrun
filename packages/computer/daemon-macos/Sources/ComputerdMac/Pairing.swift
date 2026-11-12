#if os(macOS)
import ComputerdKit
import Foundation

/// Pairing: trades the code a server's console shows for this Mac's computer id and token (POST /v2/computers/pair),
/// keeps the token in the keychain and the server in Paths.attach. Runs in the app's own executable.
public enum Pairing {
	public static func pair(server: String, code typed: String, name: String?) async throws -> AttachSettings {
		guard let code = Attach.pairingCode(typed) else {
			throw RPCError.invalid("\(typed) is not a pairing code: it is eight letters and digits, as K7PD-W3QX")
		}
		let base = try AttachSettings.base(server)
		let hello = try helloFromApp()
		let name = name ?? Host.current().localizedName ?? "Mac"
		var request = URLRequest(url: try AttachSettings.pairURL(server))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try Coders.encode(PairRequest(code: code, name: name, hello: hello))
		let (data, response) = try await URLSession.shared.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw RPCError.invalid("\(base) sent no HTTP answer") }
		guard http.statusCode == 200 || http.statusCode == 201 else {
			throw RPCError.denied("\(base) refused the code (\(http.statusCode)): \(words(data))")
		}
		let result: PairResult
		do {
			result = try JSONDecoder().decode(PairResult.self, from: data)
		} catch {
			throw RPCError.invalid("\(base)'s answer is not a pairing: \(error)")
		}
		try Keychain.save(token: result.token, computer: result.computer)
		let settings = AttachSettings(server: base.absoluteString, computer: result.computer)
		try settings.save()
		return settings
	}

	public static func unpair() {
		Keychain.forget()
		try? FileManager.default.removeItem(atPath: Paths.attach)
	}

	/// The running app's hello, through its socket: what the server records this Mac as.
	static func helloFromApp() throws -> HelloResult {
		let fd = try UnixSocket.connect(Paths.socket)
		defer { close(fd) }
		FDOutput.writeAll(fd, Data(#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"computerd-pair"}}"#.utf8) + Data([10]))
		var reply = Data()
		var buffer = [UInt8](repeating: 0, count: 64 * 1024)
		while !reply.contains(10) {
			let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
			if n <= 0 { break }
			reply.append(contentsOf: buffer[0..<n])
		}
		struct Reply: Decodable {
			struct Failure: Decodable { var message: String }
			var result: HelloResult?
			var error: Failure?
		}
		let line = reply.split(separator: 10).first.map { Data($0) } ?? Data()
		guard let decoded = try? JSONDecoder().decode(Reply.self, from: line) else { throw RPCError.invalid("Computerd sent no hello") }
		if let error = decoded.error { throw RPCError.denied("Computerd refused hello: \(error.message)") }
		guard let hello = decoded.result else { throw RPCError.invalid("Computerd sent no hello") }
		return hello
	}

	/// A server's error body in words: its message when it is JSON with one, else its first 300 characters.
	static func words(_ data: Data) -> String {
		if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			if let message = object["message"] as? String { return message }
			if let error = object["error"] as? [String: Any], let message = error["message"] as? String { return message }
			if let error = object["error"] as? String { return error }
		}
		return String(String(decoding: data, as: UTF8.self).prefix(300))
	}
}
#endif
