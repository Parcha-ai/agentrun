#if os(macOS)
import ComputerdKit
import Foundation

/// Pairing, served by the agent on its unix socket (Control.pair, Control.unpair). The agent lives in the user's login
/// session and owns the keychain; the command line, `Computerd --pair` and the window all hand it the server and code,
/// so a pair started over SSH keeps its token the same way as one from the window.
public enum Pairing {
	/// The pairer the agent runs: URLSession, the keychain, Paths.attach.
	public static func pairer() -> Pairer {
		Pairer(
			post: { url, body in
				var request = URLRequest(url: url)
				request.httpMethod = "POST"
				request.setValue("application/json", forHTTPHeaderField: "Content-Type")
				request.httpBody = body
				let (data, response) = try await URLSession.shared.data(for: request)
				guard let http = response as? HTTPURLResponse else { throw RPCError.invalid("\(url.host ?? url.absoluteString) sent no HTTP answer") }
				return (http.statusCode, data)
			},
			keep: { token, computer in try Keychain.save(token: token, computer: computer) }
		)
	}

	/// Adds the control calls to a socket connection's methods. hello: the driver's, what the server records this Mac
	/// as. changed: after a pair or an unpair, so the agent dials its new server or stops dialing.
	public static func controls(hello: @escaping @Sendable () -> HelloResult, changed: @escaping @Sendable () -> Void) -> @Sendable (inout Router) -> Void {
		{ router in
			router.on(Control.pair, PairParams.self) { p in
				let settings = try await pairer().pair(p, name: Host.current().localizedName ?? "Mac", hello: hello())
				log("paired with \(settings.server) as computer \(settings.computer)")
				changed()
				return settings
			}
			router.on(Control.unpair, Empty.self) { _ in
				unpair()
				log("unpaired")
				changed()
				return Empty()
			}
		}
	}

	public static func unpair() {
		Keychain.forget()
		try? FileManager.default.removeItem(atPath: Paths.attach)
	}
}
#endif
