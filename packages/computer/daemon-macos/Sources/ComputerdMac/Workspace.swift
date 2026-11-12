#if os(macOS)
import AppKit
import ComputerdKit
import Foundation

/// Apps through NSWorkspace: the ones with a Dock presence, launched without coming to the front when asked.
final class MacWorkspace: Workspace, @unchecked Sendable {
	init() {}

	/// NSWorkspace opens an app without activating it. An app that brings itself forward anyway is sent back, and the
	/// app that was in front is made active again.
	var backgroundLaunch: Feature { .on }

	func list() -> AppsListResult {
		var seen = Set<String>()
		var apps: [App] = []
		for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
			guard let id = app.bundleIdentifier, seen.insert(id).inserted else { continue }
			let version = app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String }
			apps.append(App(id: id, name: app.localizedName, version: version))
		}
		apps.sort { $0.id < $1.id }
		return AppsListResult(apps: apps, foreground: NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
	}

	func launch(_ id: String, url: String?, background: Bool) async throws {
		guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
			throw RPCError.notFound("no app with the bundle id \(id) is installed")
		}
		let front = NSWorkspace.shared.frontmostApplication
		let config = NSWorkspace.OpenConfiguration()
		config.activates = !background
		let launched: NSRunningApplication
		do {
			if let url {
				guard let parsed = URL(string: url), parsed.scheme != nil else { throw RPCError.invalid("\(url) is not a URL") }
				launched = try await NSWorkspace.shared.open([parsed], withApplicationAt: appURL, configuration: config)
			} else {
				launched = try await NSWorkspace.shared.openApplication(at: appURL, configuration: config)
			}
		} catch let error as RPCError {
			throw error
		} catch {
			throw RPCError.invalid("\(id) did not open: \(error.localizedDescription)")
		}
		guard background, let front, front.processIdentifier != launched.processIdentifier else { return }
		// An app that activates itself on open takes the front within a moment; give it back.
		for _ in 0..<10 {
			try? await Task.sleep(nanoseconds: 50_000_000)
			if NSWorkspace.shared.frontmostApplication?.processIdentifier == launched.processIdentifier {
				front.activate()
				return
			}
		}
	}

	func terminate(_ id: String) throws {
		let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { !$0.isTerminated }
		guard !apps.isEmpty else { throw RPCError.notFound("\(id) is not running") }
		for app in apps { app.terminate() }
	}
}
#endif
