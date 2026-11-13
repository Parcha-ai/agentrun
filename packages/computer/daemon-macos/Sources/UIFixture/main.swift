// The ui fixture on macOS (ai.agentrun.uifixture): the small app the computer protocol's ui conformance cases know,
// built to packages/computer/src/conformance/ui-fixture.ts. Its window is 320 by 320 points with its content under a
// transparent title bar, so each element's frame here is its bounds in window points there.
//
//   home     "UI fixture" heading, a "Name" text field, a "Wi-Fi" switch (desc "Networks nearby"), "Save", "Next", and a
//            "Canvas" that only foreground input reaches, whose value counts the clicks that reached it
//   saved    home, plus the text "Saved", SAVED_MS after Save
//   second   "Second page" heading and "Back", NEXT_MS after Next and a NEXT_ANIMATE_MS fade; Back returns home. Home's
//            views leave the window, so their refs are stale there, and come back as the same elements.
//
// Its windows: home also holds "New window" (id open), which opens a second window titled "Another window" NEW_WINDOW_MS
// after its press, in front, "Close" (id close), which closes the window it is in, and a "Code" text field (id code)
// that takes back any value set into it TAKES_BACK_MS later; "Another window" holds its
// heading and its own Close. Closing the last window leaves the app running with none, as a Mac app does, and opening
// the app again (apps.launch) shows its main window on its home screen.
//
// Started with --input-log PATH it is the desktop input fixture instead (InputFixture.swift).
#if os(macOS)
import AppKit

/// The fixture as ui-fixture.ts names it: its app id (App/UIFixture-Info.plist's CFBundleIdentifier, checked at launch)
/// and its window's size in points.
enum Spec {
	static let id = "ai.agentrun.uifixture"
	static let size = NSSize(width: 320, height: 320)
}

let savedMs = 300
let nextMs = 200
let nextAnimateMs = 300
let newWindowMs = 300
let takesBackMs = 150
let size = Spec.size

/// A view whose frames read from the top left, as window points do.
final class Flipped: NSView {
	override var isFlipped: Bool { true }
}

/// Takes foreground input only: it has no accessibility action, and a click counts only while the app is in front, so
/// input posted to the app from behind never reaches it. Its value is the number of clicks that did, "0" at launch.
final class Canvas: NSView {
	var clicks = 0

	override var isFlipped: Bool { true }

	override func draw(_ dirty: NSRect) {
		NSColor(white: clicks % 2 == 0 ? 0.9 : 0.7, alpha: 1).setFill()
		bounds.fill()
	}

	override func mouseDown(with event: NSEvent) {
		guard NSApp.isActive else { return }
		clicks += 1
		setAccessibilityValue("\(clicks)")
		needsDisplay = true
	}
}

/// The Code field's refusal: a value that shows in it is gone takesBackMs later. The field is read every 20 ms, so a
/// value counts however it came (typed, pasted, or set through Accessibility, which sets the cell and tells no one).
@MainActor
final class TakesBack: NSObject {
	let field: NSTextField
	var shown = ""

	private init(_ field: NSTextField) {
		self.field = field
	}

	/// The timer keeps the watcher, for as long as the app runs.
	static func watch(_ field: NSTextField) {
		Timer.scheduledTimer(timeInterval: 0.02, target: TakesBack(field), selector: #selector(look), userInfo: nil, repeats: true)
	}

	@objc func look() {
		let now = field.currentEditor()?.string ?? field.stringValue
		guard now != shown else { return }
		shown = now
		NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(clear), object: nil)
		if !now.isEmpty { perform(#selector(clear), with: nil, afterDelay: Double(takesBackMs) / 1000) }
	}

	@objc func clear() {
		field.currentEditor()?.string = ""
		field.stringValue = ""
	}
}

@MainActor
final class Fixture: NSObject, NSApplicationDelegate {
	let window = NSWindow(
		contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
	let root = Flipped(frame: NSRect(origin: .zero, size: size))
	let home = Flipped(frame: NSRect(origin: .zero, size: size))
	let second = Flipped(frame: NSRect(origin: .zero, size: size))
	let saved = NSTextField(labelWithString: "Saved")
	/// The windows New window opened that are still open.
	var others: [NSWindow] = []

	func applicationDidFinishLaunching(_ note: Notification) {
		window.titlebarAppearsTransparent = true
		window.title = "UI fixture"
		// Closed by Close and shown again by a reopen: the window object stays.
		window.isReleasedWhenClosed = false
		window.setFrame(NSRect(origin: .zero, size: size), display: false)
		window.center()
		window.contentView = root

		home.addSubview(heading("UI fixture"))
		let name = NSTextField(frame: NSRect(x: 16, y: 56, width: 200, height: 28))
		name.stringValue = ""
		name.placeholderString = "Name"
		name.setAccessibilityLabel("Name")
		mark(name, "name")
		home.addSubview(name)

		let code = NSTextField(frame: NSRect(x: 228, y: 56, width: 76, height: 28))
		code.stringValue = ""
		code.placeholderString = "Code"
		code.setAccessibilityLabel("Code")
		mark(code, "code")
		home.addSubview(code)
		TakesBack.watch(code)

		let wifi = NSSwitch(frame: NSRect(x: 16, y: 96, width: 60, height: 28))
		wifi.setAccessibilityLabel("Wi-Fi")
		wifi.setAccessibilityHelp("Networks nearby")
		mark(wifi, "wifi")
		home.addSubview(wifi)

		home.addSubview(button("Save", "save", x: 16, y: 136, action: #selector(save)))
		home.addSubview(button("Next", "next", x: 112, y: 136, action: #selector(next)))
		home.addSubview(button("New window", "open", x: 92, y: 96, width: 104, action: #selector(openAnother)))
		home.addSubview(button("Close", "close", x: 208, y: 96, action: #selector(closeWindow)))

		let canvas = Canvas(frame: NSRect(x: 16, y: 180, width: 200, height: 100))
		canvas.setAccessibilityElement(true)
		canvas.setAccessibilityRole(.image)
		canvas.setAccessibilityLabel("Canvas")
		canvas.setAccessibilityValue("0")
		mark(canvas, "canvas")
		home.addSubview(canvas)

		saved.frame = NSRect(x: 208, y: 136, width: 80, height: 28)

		second.addSubview(heading("Second page"))
		second.addSubview(button("Back", "back", x: 16, y: 56, action: #selector(back)))

		root.addSubview(home)
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

	/// Opened again with no window: the main window comes back on its home screen.
	func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
		guard !hasVisibleWindows else { return true }
		back()
		window.makeKeyAndOrderFront(nil)
		return false
	}

	func heading(_ words: String) -> NSTextField {
		let label = NSTextField(labelWithString: words)
		label.frame = NSRect(x: 16, y: 16, width: 300, height: 24)
		label.font = .boldSystemFont(ofSize: 17)
		label.setAccessibilityRole(NSAccessibility.Role(rawValue: "AXHeading"))
		return label
	}

	func button(_ title: String, _ id: String, x: CGFloat, y: CGFloat, width: CGFloat = 80, action: Selector) -> NSButton {
		let b = NSButton(title: title, target: self, action: action)
		b.frame = NSRect(x: x, y: y, width: width, height: 28)
		mark(b, id)
		return b
	}

	/// The id ui.observe shows: the view's accessibility identifier.
	func mark(_ view: NSView, _ id: String) {
		view.identifier = NSUserInterfaceItemIdentifier(id)
		view.setAccessibilityIdentifier(id)
	}

	func later(_ ms: Int, _ body: @escaping @MainActor () -> Void) {
		DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { MainActor.assumeIsolated { body() } }
	}

	@objc func save() {
		later(savedMs) { [self] in
			if saved.superview == nil { home.addSubview(saved) }
		}
	}

	@objc func next() {
		later(nextMs) { [self] in
			NSAnimationContext.runAnimationGroup({ context in
				context.duration = Double(nextAnimateMs) / 1000
				home.animator().alphaValue = 0
			}, completionHandler: { [self] in
				MainActor.assumeIsolated {
					home.removeFromSuperview()
					home.alphaValue = 1
					saved.removeFromSuperview()
					root.addSubview(second)
					window.title = "Second page"
				}
			})
		}
	}

	@objc func back() {
		second.removeFromSuperview()
		root.addSubview(home)
		window.title = "UI fixture"
	}

	/// "Another window", newWindowMs after the press, in front of the main window.
	@objc func openAnother() {
		later(newWindowMs) { [self] in
			let another = NSWindow(
				contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
			another.titlebarAppearsTransparent = true
			another.isReleasedWhenClosed = false
			another.title = "Another window"
			let content = Flipped(frame: NSRect(origin: .zero, size: size))
			let title = heading("Another window")
			content.addSubview(title)
			content.addSubview(button("Close", "close", x: 16, y: 56, action: #selector(closeWindow)))
			another.contentView = content
			another.setFrame(NSRect(origin: .zero, size: size), display: false)
			another.setFrameTopLeftPoint(NSPoint(x: window.frame.minX + 40, y: window.frame.maxY - 40))
			others.append(another)
			another.makeKeyAndOrderFront(nil)
		}
	}

	/// Closes the window the pressed Close is in.
	@objc func closeWindow(_ sender: NSButton) {
		guard let closing = sender.window else { return }
		closing.close()
		others.removeAll { $0 === closing }
	}
}

guard Bundle.main.bundleIdentifier == Spec.id else {
	FileHandle.standardError.write(Data("the ui fixture's bundle id is \(Bundle.main.bundleIdentifier ?? "none"), not \(Spec.id): run it as UIFixture.app from bundle.sh\n".utf8))
	exit(1)
}

// --input-log PATH: the desktop input fixture instead (InputFixture.swift).
let inputLog = CommandLine.arguments.firstIndex(of: "--input-log").flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil }

MainActor.assumeIsolated {
	let app = NSApplication.shared
	let delegate: NSApplicationDelegate = inputLog.map { InputFixture(log: $0) } ?? Fixture()
	app.delegate = delegate
	app.setActivationPolicy(.regular)
	app.run()
}
#else
print("the ui fixture runs on macOS only")
#endif
