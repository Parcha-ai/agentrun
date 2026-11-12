#if os(macOS)
import ComputerdKit
import ComputerdMac
import Foundation
import ServiceManagement

/// The LaunchAgent, from Contents/Library/LaunchAgents in the bundle: registered by the app the first time a person
/// opens it, so it starts at login in the Aqua session and launchd restarts it if it ends.
enum Agent {
	static let service = SMAppService.agent(plistName: "\(AttachSettings.agentLabel).plist")

	static func register() {
		guard service.status != .enabled else { return }
		do {
			try service.register()
			log("registered the LaunchAgent: \(state)")
		} catch {
			log("cannot register the LaunchAgent: \(error.localizedDescription)")
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
