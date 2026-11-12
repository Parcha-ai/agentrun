#if os(macOS)
import AppKit
import ComputerdKit
import Foundation

/// Apps through NSWorkspace: the ones installed in the Applications folders and the ones running with a Dock presence,
/// launched without coming to the front when asked.
final class MacWorkspace: Workspace, @unchecked Sendable {
	init() {}

	/// NSWorkspace opens an app without activating it. An app that brings itself forward anyway is sent back, and the
	/// app that was in front is made active again.
	var backgroundLaunch: Feature { .on }

	/// Where installed apps are, as the Finder's Applications shows them.
	static let folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]

	/// What apps.launch can open: every app in the Applications folders, and every app running with a Dock presence
	/// (the Finder, an app opened from elsewhere).
	func list() -> AppsListResult {
		var byID: [String: App] = [:]
		func add(_ url: URL, name: String?) {
			guard let info = Bundle(url: url)?.infoDictionary, let id = info["CFBundleIdentifier"] as? String, byID[id] == nil else { return }
			let shown = name ?? (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? url.deletingPathExtension().lastPathComponent
			byID[id] = App(id: id, name: shown, version: info["CFBundleShortVersionString"] as? String)
		}
		for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
			if let url = app.bundleURL { add(url, name: app.localizedName) }
		}
		for folder in Self.folders {
			let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
			for name in names where name.hasSuffix(".app") { add(URL(fileURLWithPath: folder).appendingPathComponent(name), name: nil) }
		}
		let apps = byID.values.sorted { $0.id < $1.id }
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
