#if os(macOS)
import ComputerdKit
import ComputerdMac
import Foundation
import Security
import ServiceManagement

/// The LaunchAgent, from Contents/Library/LaunchAgents in the bundle: registered by the app the first time a person
/// opens it, so it starts at login in the Aqua session and launchd restarts it if it ends.
///
/// Registering records a launch constraint for the build that registered. A Developer ID build's constraint names its
/// team, so any later build of it still launches. A self-signed build's names that very build: once a new build is
/// installed, launchd kills the agent at spawn ("Launch Constraint Violation", exit 78 "needs LWCR update") while the
/// service still reads as enabled. So the app keeps the build it registered, and a different build registers again:
/// unregister, awaited, then register.
enum Agent {
	static let service = SMAppService.agent(plistName: "\(AttachSettings.agentLabel).plist")
	static let registeredKey = "registeredBuild"
	/// Where the last registration's outcome is written, for a script that cannot ask SMAppService itself (over SSH).
	static let statusPath = NSHomeDirectory() + "/Library/Application Support/Computerd/agent-status.txt"

	/// This build: the code directory hash of the running app, which changes with every build; else its version and the
	/// executable's time.
	static var build: String {
		var code: SecCode?
		var staticCode: SecStaticCode?
		var info: CFDictionary?
		if SecCodeCopySelf([], &code) == errSecSuccess, let code,
			SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
			SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
			let unique = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data
		{
			return "cdhash " + unique.map { String(format: "%02x", $0) }.joined()
		}
		let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
		let built = Bundle.main.executableURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date }
		return "version \(version), built \(built.map { "\($0.timeIntervalSince1970)" } ?? "?")"
	}

	/// The agent is registered for this build: enabled, and registered by it.
	static var current: Bool {
		service.status == .enabled && UserDefaults.standard.string(forKey: registeredKey) == build
	}

	/// Registers the agent for this build, unless it already is; with force, again in any case. Unregisters first
	/// (awaited) whenever the service is known to launchd, so the launch constraint is recorded anew. Logs each result,
	/// writes the outcome to statusPath, and answers the status after.
	@discardableResult
	static func register(force: Bool = false) async -> SMAppService.Status {
		let build = self.build
		let before = service.status
		let recorded = UserDefaults.standard.string(forKey: registeredKey)
		if !force && before == .enabled && recorded == build {
			log("the LaunchAgent is registered for this build (\(build))")
			write(before)
			return before
		}
		log("registering the LaunchAgent for \(build): it is \(name(before)), registered for \(recorded ?? "no recorded build")")
		if before != .notRegistered && before != .notFound {
			do {
				try await service.unregister()
				log("unregistered the LaunchAgent: it is \(name(service.status))")
			} catch {
				log("cannot unregister the LaunchAgent (registering anyway): \(error.localizedDescription)")
			}
		}
		do {
			try service.register()
			UserDefaults.standard.set(build, forKey: registeredKey)
			log("registered the LaunchAgent: it is \(name(service.status))")
		} catch {
			log("cannot register the LaunchAgent: \(error.localizedDescription); it is \(name(service.status))")
		}
		let after = service.status
		write(after)
		return after
	}

	/// Unregisters the agent, awaited, and forgets the build it was registered for.
	static func unregister() async -> SMAppService.Status {
		do {
			try await service.unregister()
			log("unregistered the LaunchAgent: it is \(name(service.status))")
		} catch {
			log("cannot unregister the LaunchAgent: \(error.localizedDescription); it is \(name(service.status))")
		}
		UserDefaults.standard.removeObject(forKey: registeredKey)
		let after = service.status
		write(after)
		return after
	}

	static func write(_ status: SMAppService.Status) {
		let path = URL(fileURLWithPath: statusPath)
		try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
		try? "\(name(status))\n".write(to: path, atomically: true, encoding: .utf8)
	}

	static func name(_ status: SMAppService.Status) -> String {
		switch status {
		case .enabled: return "enabled"
		case .requiresApproval: return "requiresApproval"
		case .notRegistered: return "notRegistered"
		case .notFound: return "notFound"
		@unknown default: return "unknown"
		}
	}

	static var state: String {
		switch service.status {
		case .enabled: return "Running, and starts at login"
		case .requiresApproval: return "Waiting for you: allow Computerd in System Settings > General > Login Items"
		case .notRegistered: return "Not registered"
		case .notFound: return "Missing from the app bundle"
		@unknown default: return "Unknown"
		}
	}

	static func openLoginItems() {
		SMAppService.openSystemSettingsLoginItems()
	}
}
#endif
