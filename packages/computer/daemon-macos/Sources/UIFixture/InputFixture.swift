// The desktop input fixture on macOS: UIFixture.app started with --input-log PATH, the window the screen and input
// conformance cases check effects with (packages/computer/src/conformance/fixture.ts). A borderless 200 by 200 point
// window at the main display's top left, over the menu bar, in the four colors of FIXTURE_COLORS, that takes focus and
// logs every input event it gets as one JSON line: points in screenshot pixels (the display's points times its scale,
// origin top left). Its first line, once it is in front with its window key, is
// {"event":"ready","pid":N,"bounds":[x,y,w,h]}: the window in screenshot pixels, which the cases aim inside.
#if os(macOS)
import AppKit

/// A borderless window that still becomes key, so keys come to it.
final class KeyWindow: NSWindow {
	override var canBecomeKey: Bool { true }
	override var canBecomeMain: Bool { true }
}

/// Paints the quadrants and logs what reaches it.
final class InputView: NSView {
	var log: (([String: Any]) -> Void)?
	/// The display's top left in screen coordinates and its scale, for pixels.
	var screenTop: CGFloat = 0
	var screenLeft: CGFloat = 0
	var scale: CGFloat = 1
	var colorSpace: NSColorSpace = .sRGB

	override var acceptsFirstResponder: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

	override func draw(_ dirty: NSRect) {
		// FIXTURE_COLORS, top left, top right, bottom left, bottom right, in the display's own color space so a
		// screenshot reads the same numbers. The view's origin is its bottom left.
		let colors: [[CGFloat]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]]
		let w = bounds.width / 2
		let h = bounds.height / 2
		let rects = [NSRect(x: 0, y: h, width: w, height: h), NSRect(x: w, y: h, width: w, height: h), NSRect(x: 0, y: 0, width: w, height: h), NSRect(x: w, y: 0, width: w, height: h)]
		for (rect, rgb) in zip(rects, colors) {
			var components = rgb + [1]
			NSColor(colorSpace: colorSpace, components: &components, count: 4).setFill()
			rect.fill()
		}
	}

	func pixels(_ event: NSEvent) -> [Int] {
		let screen = event.window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation
		return [Int(((screen.x - screenLeft) * scale).rounded()), Int(((screenTop - screen.y) * scale).rounded())]
	}

	func pointer(_ name: String, _ button: String, _ event: NSEvent) {
		log?(["event": name, "button": button, "at": pixels(event)])
	}

	override func mouseDown(with event: NSEvent) { pointer("down", "left", event) }
	override func mouseUp(with event: NSEvent) { pointer("up", "left", event) }
	override func rightMouseDown(with event: NSEvent) { pointer("down", "right", event) }
	override func rightMouseUp(with event: NSEvent) { pointer("up", "right", event) }
	override func otherMouseDown(with event: NSEvent) { pointer("down", "middle", event) }
	override func otherMouseUp(with event: NSEvent) { pointer("up", "middle", event) }

	override func scrollWheel(with event: NSEvent) {
		// dx and dy above 0 show what is right and below, as input.actions' scroll names them.
		log?(["event": "wheel", "at": pixels(event), "dx": -Double(event.scrollingDeltaX), "dy": -Double(event.scrollingDeltaY)])
	}

	override func keyDown(with event: NSEvent) {
		log?(["event": "key", "key": event.charactersIgnoringModifiers ?? "", "down": true])
		let chord = event.modifierFlags.intersection([.command, .control])
		if chord.isEmpty, let text = event.characters, !text.isEmpty {
			// Return comes as "\r"; the cases compare what was typed, newlines as "\n".
			log?(["event": "text", "text": text.replacingOccurrences(of: "\r", with: "\n")])
		}
	}

	override func keyUp(with event: NSEvent) {
		log?(["event": "key", "key": event.charactersIgnoringModifiers ?? "", "down": false])
	}
}

@MainActor
final class InputFixture: NSObject, NSApplicationDelegate {
	static let sizePoints: CGFloat = 200

	let path: String
	var handle: FileHandle?
	var window: KeyWindow?
	var readyLogged = false

	init(log path: String) {
		self.path = path
	}

	func write(_ line: [String: Any]) {
		guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
		handle?.write(data + Data([10]))
	}

	func applicationDidFinishLaunching(_ note: Notification) {
		FileManager.default.createFile(atPath: path, contents: nil)
		handle = FileHandle(forWritingAtPath: path)
		guard let screen = NSScreen.screens.first else {
			FileHandle.standardError.write(Data("the input fixture found no display\n".utf8))
			exit(1)
		}
		let size = Self.sizePoints
		let frame = NSRect(x: screen.frame.minX, y: screen.frame.maxY - size, width: size, height: size)
		let window = KeyWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
		window.level = .screenSaver
		window.isOpaque = true
		window.hasShadow = false
		let view = InputView(frame: NSRect(origin: .zero, size: frame.size))
		view.screenTop = screen.frame.maxY
		view.screenLeft = screen.frame.minX
		view.scale = screen.backingScaleFactor
		view.colorSpace = screen.colorSpace ?? .sRGB
		view.log = { [weak self] line in self?.write(line) }
		window.contentView = view
		window.makeKeyAndOrderFront(nil)
		window.makeFirstResponder(view)
		self.window = window
		NSApp.activate(ignoringOtherApps: true)
		checkReady(tries: 0)
	}

	/// Logs ready once the app is in front with its window key, so input sent after ready lands here.
	func checkReady(tries: Int) {
		guard let window, let screen = NSScreen.screens.first, !readyLogged else { return }
		if NSApp.isActive && window.isKeyWindow {
			readyLogged = true
			let scale = screen.backingScaleFactor
			let px = Int((Self.sizePoints * scale).rounded())
			write(["event": "ready", "pid": Int(ProcessInfo.processInfo.processIdentifier), "bounds": [0, 0, px, px]])
			return
		}
		if tries % 10 == 9 {
			NSApp.activate(ignoringOtherApps: true)
			window.makeKeyAndOrderFront(nil)
		}
		DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100)) { MainActor.assumeIsolated { self.checkReady(tries: tries + 1) } }
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}
#endif
