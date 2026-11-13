#if os(macOS)
import CComputerd
import ComputerdKit
import Foundation
import Security

/// Who may talk to the app's socket: a process of this user whose code is Computerd's own, the app or the computerd
/// command in its bundle, as their designated requirements say. With a Developer ID signature that is any build of
/// Computerd by the same team; with an ad-hoc one, exactly these binaries.
public final class PeerAuth: @unchecked Sendable {
	let requirements: [SecRequirement]
	let names: [String]

	/// The requirements of the app's executable and of the command beside it.
	public init(bundle: Bundle = .main) {
		var requirements: [SecRequirement] = []
		var names: [String] = []
		var paths = [bundle.executableURL]
		paths.append(bundle.bundleURL.appendingPathComponent("Contents/Helpers/computerd"))
		for case let url? in paths where FileManager.default.fileExists(atPath: url.path) {
			var code: SecStaticCode?
			guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { continue }
			var requirement: SecRequirement?
			guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess, let requirement else { continue }
			requirements.append(requirement)
			names.append(url.lastPathComponent)
		}
		self.requirements = requirements
		self.names = names
	}

	/// Nil when the peer may talk, else why not.
	public func refuse(_ fd: Int32) -> String? {
		var peer = computerd_peer()
		guard computerd_peer_of(fd, &peer) == 0 else { return "its peer cannot be read: \(String(cString: strerror(errno)))" }
		guard peer.euid == getuid() else { return "process \(peer.pid) runs as uid \(peer.euid), not this user's \(getuid())" }
		guard !requirements.isEmpty else { return "Computerd cannot read its own signature, so it trusts no client" }
		let token = withUnsafeBytes(of: peer.audit_token) { Data($0) }
		var code: SecCode?
		let attributes = [kSecGuestAttributeAudit: token] as CFDictionary
		guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else {
			return "process \(peer.pid)'s code cannot be found"
		}
		for requirement in requirements where SecCodeCheckValidity(code, [], requirement) == errSecSuccess { return nil }
		return "process \(peer.pid) is not signed as Computerd (\(names.joined(separator: " or "))): connect through Computerd.app's computerd command"
	}
}
#endif
