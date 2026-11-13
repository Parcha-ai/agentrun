#if os(macOS)
import AppKit
import ComputerdKit
import ComputerdMac
import Foundation

/// The grants window: one section per System Settings pane that gives Computerd a grant, each with a tile of the app to
/// drag into that pane's list and a row per grant that ticks as it comes in. The first pane still waiting opens beside
/// the window when it shows, the next one when that one's grants are in, and the window says so and closes once every
/// grant is in. A click on a tile opens its pane too. The grants are read on a timer while the window is open.
@MainActor
final class GrantsWindow: NSObject, NSWindowDelegate {
	let window: NSWindow
	var board: GrantsBoard
	let heading = NSTextField(labelWithString: "")
	var tiles: [GrantTile] = []
	var rows: [(grant: String, mark: NSImageView)] = []
	var timer: Timer?
	/// Runs when every grant is in, just before the window closes.
	let onDone: () -> Void
	/// Runs when the window has closed, done or not.
	let onClose: () -> Void

	init(panes: [GrantsBoard.Pane], onDone: @escaping () -> Void, onClose: @escaping () -> Void) {
		board = GrantsBoard(panes: panes)
		self.onDone = onDone
		self.onClose = onClose
		window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
		super.init()
		window.title = "Computerd"
		window.isReleasedWhenClosed = false
		// Above System Settings, which takes the front each time a pane opens: the tile has to stay in reach.
		window.level = .floating
		window.delegate = self
		build()
	}

	func build() {
		let stack = NSStackView()
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 18
		stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 22, right: 24)
		heading.font = .boldSystemFont(ofSize: 15)
		heading.stringValue = "Drag Computerd into each list"
		stack.addArrangedSubview(heading)
		for pane in board.panes {
			let tile = GrantTile(pane: pane) { [weak self] anchor in self?.choose(anchor) }
			tiles.append(tile)
			let name = NSTextField(labelWithString: pane.name)
			name.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
			let list = NSStackView(views: [name])
			list.orientation = .vertical
			list.alignment = .leading
			list.spacing = 6
			for grant in pane.grants {
				let mark = NSImageView()
				mark.widthAnchor.constraint(equalToConstant: 16).isActive = true
				mark.heightAnchor.constraint(equalToConstant: 16).isActive = true
				let what = NSTextField(labelWithString: grant)
				let why = NSTextField(labelWithString: Permissions.Grant(rawValue: grant).map { "to \($0.purpose)" } ?? "")
				why.textColor = .secondaryLabelColor
				why.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
				let words = NSStackView(views: [what, why])
				words.orientation = .vertical
				words.alignment = .leading
				words.spacing = 1
				let row = NSStackView(views: [mark, words])
				row.orientation = .horizontal
				row.alignment = .top
				row.spacing = 8
				list.addArrangedSubview(row)
				rows.append((grant, mark))
			}
			let section = NSStackView(views: [tile, list])
			section.orientation = .horizontal
			section.alignment = .centerY
			section.spacing = 16
			stack.addArrangedSubview(section)
		}
		window.contentView = stack
		window.setContentSize(stack.fittingSize)
	}

	/// Brings the window up and looks at the grants at once, which opens the first pane still waiting.
	func show() {
		if !window.isVisible { window.center() }
		window.makeKeyAndOrderFront(nil)
		NSApp.activate()
		look()
		guard timer == nil, !board.finished else { return }
		timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
			MainActor.assumeIsolated { self?.look() }
		}
	}

	func windowWillClose(_ notification: Notification) {
		timer?.invalidate()
		timer = nil
		onClose()
	}

	/// Reads the grants, ticks the rows and does what the board answers.
	func look() {
		let steps = board.observe(Permissions.granted)
		render()
		for step in steps {
			switch step {
			case .open(let pane): open(pane)
			case .done: finish()
			}
		}
	}

	func render() {
		for row in rows {
			let granted = board.isGranted(row.grant)
			row.mark.image = NSImage(systemSymbolName: granted ? "checkmark.circle.fill" : "circle", accessibilityDescription: granted ? "granted" : "not granted")
			row.mark.contentTintColor = granted ? .systemGreen : .tertiaryLabelColor
		}
		for tile in tiles { tile.enabled = !board.isGranted(tile.pane) }
	}

	func choose(_ anchor: String) {
		if let pane = board.choose(anchor) { open(pane) }
	}

	/// Opens the pane in System Settings and moves this window beside it, once System Settings has drawn it.
	func open(_ pane: GrantsBoard.Pane) {
		guard let url = URL(string: pane.url) else { return }
		NSWorkspace.shared.open(url)
		for delay in [0.4, 1.0, 2.0] {
			DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.dock() }
		}
	}

	/// Every grant is in: the window says so for a moment and goes, so it never covers the windows an agent works in.
	func finish() {
		timer?.invalidate()
		timer = nil
		heading.stringValue = "Computerd has every grant"
		DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
			guard let self, self.window.isVisible else { return }
			self.onDone()
			self.window.close()
		}
	}

	/// Puts the window beside System Settings' front window, on its left when there is room, else its right, tops level.
	/// Window bounds come without the Screen Recording grant; names would not.
	func dock() {
		guard window.isVisible, !board.finished,
			let settings = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first,
			let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
		else { return }
		// Front to back: the first normal-layer window System Settings owns is the one with the pane.
		let bounds = list.first { info in
			(info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == settings.processIdentifier && (info[kCGWindowLayer as String] as? Int) == 0
		}.flatMap { info in (info[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } }
		guard let bounds, let main = NSScreen.screens.first else { return }
		// Window bounds are in global display coordinates, from the main display's top left; AppKit's from its bottom left.
		let other = NSRect(x: bounds.minX, y: main.frame.maxY - bounds.maxY, width: bounds.width, height: bounds.height)
		guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(other) }) ?? NSScreen.main else { return }
		let room = screen.visibleFrame
		let size = window.frame.size
		let gap: CGFloat = 12
		var x = other.minX - gap - size.width
		if x < room.minX { x = other.maxX + gap }
		x = min(max(x, room.minX), room.maxX - size.width)
		let y = min(max(other.maxY - size.height, room.minY), room.maxY - size.height)
		window.setFrameOrigin(NSPoint(x: x, y: y))
	}
}

/// The app's icon and name, as the Finder shows them, to drag into a System Settings list: the drag carries the app
/// bundle's file URL, as one from the Finder does. A click opens the tile's pane. Its pane's grants all in, it dims and
/// neither drags nor opens.
@MainActor
final class GrantTile: NSView, NSDraggingSource {
	let pane: GrantsBoard.Pane
	let onClick: (String) -> Void
	let icon: NSImage
	let iconView: NSImageView
	/// Where a press began, while it may still become a click or a drag.
	var pressed: NSPoint?
	var enabled = true {
		didSet {
			guard enabled != oldValue else { return }
			alphaValue = enabled ? 1 : 0.35
			window?.invalidateCursorRects(for: self)
		}
	}

	init(pane: GrantsBoard.Pane, onClick: @escaping (String) -> Void) {
		self.pane = pane
		self.onClick = onClick
		let bundle = Bundle.main.bundlePath
		icon = NSWorkspace.shared.icon(forFile: bundle)
		icon.size = NSSize(width: 64, height: 64)
		iconView = NSImageView(image: icon)
		super.init(frame: NSRect(x: 0, y: 0, width: 88, height: 90))
		let name = NSTextField(labelWithString: FileManager.default.displayName(atPath: bundle))
		name.alignment = .center
		name.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
		let stack = NSStackView(views: [iconView, name])
		stack.orientation = .vertical
		stack.spacing = 4
		stack.frame = bounds
		stack.autoresizingMask = [.width, .height]
		addSubview(stack)
		iconView.widthAnchor.constraint(equalToConstant: 64).isActive = true
		iconView.heightAnchor.constraint(equalToConstant: 64).isActive = true
		widthAnchor.constraint(equalToConstant: 88).isActive = true
		heightAnchor.constraint(equalToConstant: 90).isActive = true
		setAccessibilityElement(true)
		setAccessibilityRole(.button)
		setAccessibilityLabel("Computerd: drag into the \(pane.name) list, or press to open it")
	}

	required init?(coder: NSCoder) { nil }

	/// The tile takes its own presses: the icon and the name under it are part of it.
	override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }

	override func resetCursorRects() {
		if enabled { addCursorRect(bounds, cursor: .openHand) }
	}

	override func mouseDown(with event: NSEvent) {
		pressed = enabled ? event.locationInWindow : nil
	}

	override func mouseDragged(with event: NSEvent) {
		guard let start = pressed else { return }
		let now = event.locationInWindow
		guard hypot(now.x - start.x, now.y - start.y) > 3 else { return }
		pressed = nil
		let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
		item.setDraggingFrame(convert(iconView.bounds, from: iconView), contents: icon)
		beginDraggingSession(with: [item], event: event, source: self)
	}

	override func mouseUp(with event: NSEvent) {
		if pressed != nil { onClick(pane.anchor) }
		pressed = nil
	}

	override func accessibilityPerformPress() -> Bool {
		guard enabled else { return false }
		onClick(pane.anchor)
		return true
	}

	func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
		context == .outsideApplication ? [.copy, .link, .generic] : []
	}
}
#endif
