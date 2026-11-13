#if os(macOS)
import ComputerdKit
import Foundation
import Security

/// The attach token, in the user's keychain under the app's name. Only the executable that wrote it reads it without
/// a prompt, and only a process in the login session may write it, so pairing runs in the agent.
public enum Keychain {
	static let service = "ai.parcha.computerd.attach"

	public static func save(token: String, computer: String) throws {
		forget()
		let item: [CFString: Any] = [
			kSecClass: kSecClassGenericPassword,
			kSecAttrService: service,
			kSecAttrAccount: computer,
			kSecAttrLabel: "Computerd attach token",
			kSecValueData: Data(token.utf8),
		]
		let status = SecItemAdd(item as CFDictionary, nil)
		guard status == errSecSuccess else { throw RPCError.denied("the keychain refused the token: \(message(status))") }
	}

	public static func token(computer: String) throws -> String {
		let query: [CFString: Any] = [
			kSecClass: kSecClassGenericPassword,
			kSecAttrService: service,
			kSecAttrAccount: computer,
			kSecReturnData: true,
			kSecMatchLimit: kSecMatchLimitOne,
		]
		var found: AnyObject?
		let status = SecItemCopyMatching(query as CFDictionary, &found)
		guard status == errSecSuccess, let data = found as? Data, let token = String(data: data, encoding: .utf8) else {
			throw RPCError.notFound("the keychain has no attach token for computer \(computer): \(message(status)). Pair again")
		}
		return token
	}

	/// Deletes every token of the app's.
	public static func forget() {
		let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service]
		_ = SecItemDelete(query as CFDictionary)
	}

	static func message(_ status: OSStatus) -> String {
		(SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
	}
}
#endif
