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
		let apps = Self.installed().map(\.app).sorted { $0.id < $1.id }
		return AppsListResult(apps: apps, foreground: NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
	}

	/// Each app apps.list shows, with where it is: the running ones first, then the Applications folders.
	static func installed() -> [(app: App, url: URL)] {
		var byID: [String: (app: App, url: URL)] = [:]
		func add(_ url: URL, name: String?) {
			guard let info = Bundle(url: url)?.infoDictionary, let id = info["CFBundleIdentifier"] as? String, byID[id] == nil else { return }
			let shown = name ?? (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? url.deletingPathExtension().lastPathComponent
			byID[id] = (App(id: id, name: shown, version: info["CFBundleShortVersionString"] as? String), url)
		}
		for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
			if let url = app.bundleURL { add(url, name: app.localizedName) }
		}
		for folder in folders {
			let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
			for name in names where name.hasSuffix(".app") { add(URL(fileURLWithPath: folder).appendingPathComponent(name), name: nil) }
		}
		return Array(byID.values)
	}

	/// Where the app is: Launch Services' answer, or else the app apps.list found in the Applications folders (an app
	/// copied in moments ago that Launch Services has not registered yet).
	static func url(of id: String) -> URL? {
		NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) ?? installed().first { $0.app.id == id }?.url
	}

	func launch(_ id: String, url: String?, background: Bool) async throws {
		guard let appURL = Self.url(of: id) else {
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
		// The protocol's rule: apps.launch answers once the app has a window on screen, so a ui.observe right after finds
		// it (on macos-26 the ui fixture was in front before its window was listed), or it is refused timeout after
		// launchWindowSeconds. Opened in the background, an app that activates itself takes the front within a moment,
		// sometimes twice (once launched, again when its document's window opens): for at least 2 s, it is given back
		// each time. (On macos-26, TextEdit came forward after the first 500 ms.)
		let pid = launched.processIdentifier
		let guarded = background && front != nil && front!.processIdentifier != pid
		let start = Date()
		var shown = false
		while true {
			if guarded, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { front!.activate() }
			shown = shown || Self.hasWindow(pid)
			let waited = Date().timeIntervalSince(start)
			if shown && (!guarded || waited >= 2) { return }
			if !shown && waited >= Self.launchWindowSeconds {
				throw RPCError(.timeout, "\(id) opened, and showed no window on screen in \(Int(Self.launchWindowSeconds)) s: it may be hidden, or an app with no window (a menu bar app)")
			}
			try? await Task.sleep(nanoseconds: 50_000_000)
		}
	}

	/// How long apps.launch waits for the app's window.
	static let launchWindowSeconds: TimeInterval = 10

	/// The app shows a window: the window server lists one at the normal level, and so does the accessibility tree
	/// when Computerd may read it.
	static func hasWindow(_ pid: pid_t) -> Bool {
		let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
		let shown = list.contains { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
		guard shown else { return false }
		guard AXIsProcessTrusted() else { return true }
		var windows: CFTypeRef?
		guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &windows) == .success else { return false }
		return ((windows as? [AXUIElement]) ?? []).isEmpty == false
	}

	/// Quits the app and returns once it is gone, so a launch right after starts it afresh. An app not running is
	/// already where terminate leaves it, as the protocol's fake driver answers. One that has not quit after 3 s is
	/// forced.
	func terminate(_ id: String) throws {
		let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { !$0.isTerminated }
		for app in apps { app.terminate() }
		// By the pid, not isTerminated, which the main run loop updates: this may run on it.
		let alive = { (app: NSRunningApplication) in kill(app.processIdentifier, 0) == 0 }
		let deadline = Date().addingTimeInterval(3)
		while apps.contains(where: alive) && Date() < deadline { usleep(50_000) }
		for app in apps where alive(app) { app.forceTerminate() }
	}
}
#endif
