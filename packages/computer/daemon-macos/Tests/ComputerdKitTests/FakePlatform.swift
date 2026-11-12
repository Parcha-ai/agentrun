import Foundation
@testable import ComputerdKit

/// A fake OS for the core's tests: one app with one window and a tree the test edits, routes that record what they
/// were asked, and a clock that only moves when something sleeps.
final class FakeOS: @unchecked Sendable {
	struct Element {
		var id: Int
		var role: String
		var name: String?
		var value: String?
		var desc: String?
		var frame: Rect?
		var parent: Int?
		var flags: Set<UiFlag> = []
		var actions: [String] = []
		var settable = false
		var textInput = false
		var selectable = false
	}

	let lock = NSRecursiveLock()
	var elements: [Int: Element] = [:]
	var order: [Int] = []
	var window = UiWindow(id: "7", title: "Notes", bounds: Rect(100, 50, 800, 600))
	/// False once the app's last window closed: then no target resolves.
	var hasWindow = true
	/// Once set, the next resolve answers the window it had and then swaps in this one, as an app does when its
	/// first-run window gives way to the real one between finding a window and reading it.
	var swapAfterResolve: UiWindow?
	var app = UiApp(id: "com.apple.Notes", name: "Notes", pid: 42)
	var trusted = true
	var screenRecording = true
	var focusedID: Int?
	var frameHash = 0
	var maxNodes: Int?
	/// Called on every perform, set and post, so a test makes the UI react.
	var react: ((String, FakeOS) -> Void)?
	var log: [String] = []
	var now: Double = 0
	/// Delayed changes: at a time, run this.
	var timers: [(at: Double, run: (FakeOS) -> Void)] = []

	func with<T>(_ body: (FakeOS) throws -> T) rethrows -> T {
		lock.lock()
		defer { lock.unlock() }
		return try body(self)
	}

	@discardableResult
	func add(_ id: Int, _ role: String, name: String? = nil, value: String? = nil, desc: String? = nil, frame: Rect? = nil, parent: Int? = nil, actions: [String] = [], settable: Bool = false, textInput: Bool = false, flags: Set<UiFlag> = []) -> Int {
		with { os in
			os.elements[id] = Element(id: id, role: role, name: name, value: value, desc: desc, frame: frame, parent: parent, flags: flags, actions: actions, settable: settable, textInput: textInput)
			os.order.append(id)
		}
		return id
	}

	func remove(_ id: Int) {
		with { os in
			os.elements[id] = nil
			os.order.removeAll { $0 == id }
		}
	}

	func after(_ ms: Double, _ run: @escaping (FakeOS) -> Void) {
		with { os in os.timers.append((os.now + ms, run)) }
	}

	func record(_ entry: String) {
		with { os in os.log.append(entry) }
		react?(entry, self)
	}

	var entries: [String] { with { $0.log } }

	func platform(background: Feature = .on, foreground: Feature = .on, nav: Feature = .off("macOS has no system back, home or app switcher")) -> Platform {
		Platform(accessibility: FakeAX(os: self), capture: FakeCapture(os: self), workspace: FakeWorkspace(os: self), background: FakeRoute(os: self, name: "bg"), backgroundFeature: background, foreground: FakeRoute(os: self, name: "fg"), foregroundFeature: foreground, navFeature: nav, clock: FakeClock(os: self))
	}

	func engine(policy: Policy = Policy(), background: Feature = .on, foreground: Feature = .on) -> UIEngine {
		UIEngine(platform: platform(background: background, foreground: foreground), policy: policy)
	}
}

struct FakeAX: Accessibility {
	let os: FakeOS

	var feature: Feature { os.with { $0.trusted } ? .on : .off("Accessibility is not granted to Computerd") }
	var pressAction: String { "AXPress" }
	var menuAction: String { "AXShowMenu" }
	var confirmAction: String { "AXConfirm" }
	var incidentalActions: Set<String> { ["AXShowMenu", "AXScrollToVisible"] }

	func resolve(_ target: Target?) throws -> ResolvedTarget {
		try os.with { os in
			if let app = target?.app, app != os.app.id { throw RPCError.notFound("\(app) is not running") }
			if let window = target?.window, window != os.window.id || !os.hasWindow { throw RPCError.notFound("no window \(window)") }
			if !os.hasWindow { throw RPCError.notFound("\(os.app.id) has no window open") }
			let found = ResolvedTarget(app: os.app, pid: 42, window: os.window)
			if let swap = os.swapAfterResolve {
				os.swapAfterResolve = nil
				os.window = swap
			}
			return found
		}
	}

	func snapshot(_ target: ResolvedTarget, maxNodes: Int) throws -> Snapshot {
		try os.with { os in
			if target.window.id != os.window.id { throw RPCError.notFound("\(os.app.id) has no window \(target.window.id) any more: observe again") }
			let cap = min(maxNodes, os.maxNodes ?? maxNodes)
			var index: [Int: Int] = [:]
			var nodes: [RawNode] = []
			for id in os.order.prefix(cap) {
				let e = os.elements[id]!
				var flags = e.flags
				if os.focusedID == id { flags.insert(.focused) }
				index[id] = nodes.count
				nodes.append(RawNode(handle: ElementHandle(id), role: e.role, name: e.name, value: e.value, desc: e.desc, frame: e.frame, parent: e.parent.flatMap { index[$0] }, flags: flags, actions: e.actions, settable: e.settable, textInput: e.textInput))
			}
			return Snapshot(nodes: nodes, truncated: os.order.count > cap)
		}
	}

	func id(_ h: ElementHandle) -> Int { h.base.base as! Int }

	func exists(_ element: ElementHandle) -> Bool { os.with { $0.elements[id(element)] != nil } }
	func frame(_ element: ElementHandle) -> Rect? { os.with { $0.elements[id(element)]?.frame } }
	func value(_ element: ElementHandle) -> String? {
		os.with { os in
			guard let e = os.elements[id(element)], !e.flags.contains(.secure) else { return nil }
			return e.value
		}
	}

	func perform(_ action: String, on element: ElementHandle) throws {
		let ok = os.with { $0.elements[id(element)]?.actions.contains(action) == true }
		guard ok else { throw RouteUnavailable("no \(action)") }
		os.record("ax.\(action) \(id(element))")
	}

	func setValue(_ value: String, on element: ElementHandle) throws {
		os.with { $0.elements[id(element)]?.value = value }
		os.record("ax.set \(id(element)) \(value)")
	}

	func insertText(_ text: String, on element: ElementHandle) throws {
		let ok = os.with { $0.elements[id(element)]?.settable == true }
		guard ok else { throw RouteUnavailable("not settable") }
		os.with { os in
			let now = os.elements[id(element)]?.value ?? ""
			os.elements[id(element)]?.value = now + text
		}
		os.record("ax.insert \(id(element)) \(text)")
	}

	func focus(_ element: ElementHandle) throws {
		os.with { $0.focusedID = id(element) }
		os.record("ax.focus \(id(element))")
	}

	func select(_ element: ElementHandle) throws -> ElementHandle {
		let ok = os.with { $0.elements[id(element)]?.selectable == true }
		guard ok else { throw RouteUnavailable("not selectable") }
		os.with { $0.elements[id(element)]?.flags.insert(.selected) }
		os.record("ax.select \(id(element))")
		return element
	}

	func isSelected(_ element: ElementHandle) -> Bool { os.with { $0.elements[id(element)]?.flags.contains(.selected) == true } }

	func scrollToVisible(_ element: ElementHandle) throws {
		os.record("ax.scrolltovisible \(id(element))")
	}

	func focused(_ target: ResolvedTarget) -> ElementHandle? { os.with { $0.focusedID }.map { ElementHandle($0) } }

	func menuItem(for chord: KeyChord, in target: ResolvedTarget) -> MenuItem? {
		os.with { os in
			os.order.compactMap { os.elements[$0] }.first { $0.role == "menuitem" && $0.name == chord.text }.map {
				MenuItem(element: ElementHandle($0.id), enabled: !$0.flags.contains(.disabled))
			}
		}
	}
}

struct FakeCapture: Capture {
	let os: FakeOS

	var feature: Feature { os.with { $0.screenRecording } ? .on : .off("Screen Recording is not granted to Computerd") }

	func resolve(_ target: Target?) throws -> ResolvedTarget {
		try os.with { os in
			os.log.append("capture.resolve")
			if let app = target?.app, app != os.app.id { throw RPCError.notFound("\(app) is not running") }
			if let window = target?.window, window != os.window.id || !os.hasWindow { throw RPCError.notFound("no window \(window)") }
			if !os.hasWindow { throw RPCError.notFound("\(os.app.id) has no window open") }
			return ResolvedTarget(app: os.app, pid: 42, window: os.window)
		}
	}

	func window(_ target: ResolvedTarget, maxEdge: Int, maxBytes: Int) async throws -> Image {
		let w = target.window.bounds.w * 2
		let h = target.window.bounds.h * 2
		let scale = min(1, Double(maxEdge) / max(w, h))
		return Image(data: Data(repeating: 7, count: 2000), format: "png", width: Int(w * scale), height: Int(h * scale), scale: 2 * scale)
	}

	func screen(region: Rect?) async throws -> Image {
		Image(data: Data(repeating: 1, count: 700 * 1024), format: "png", width: 2880, height: 1800, scale: 2)
	}

	func frame(maxWidth: Int, quality: Int) async throws -> Image {
		Image(data: Data("frame\(os.with { $0.frameHash })".utf8), format: "jpeg", width: maxWidth, height: maxWidth * 5 / 8, scale: 1)
	}

	func windowHash(_ target: ResolvedTarget) async -> Int? { os.with { $0.frameHash } }

	func screenInfo() -> ScreenInfo? { ScreenInfo(width: 1440, height: 900, scale: 2) }

	func cursor() -> Point? { Point(10, 10) }
}

struct FakeWorkspace: Workspace {
	let os: FakeOS

	var backgroundLaunch: Feature { .on }

	func list() -> AppsListResult {
		AppsListResult(apps: [App(id: "com.apple.Notes", name: "Notes"), App(id: "com.apple.Safari", name: "Safari")], foreground: "com.apple.Safari")
	}

	func launch(_ id: String, url: String?, background: Bool) async throws {
		os.record("launch \(id) \(url ?? "-") \(background)")
	}

	func terminate(_ id: String) throws {
		os.record("terminate \(id)")
	}
}

struct FakeRoute: InputRoute {
	let os: FakeOS
	let name: String

	func fmt(_ p: Point) -> String { "\(Int(p.x)),\(Int(p.y))" }

	func click(at point: Point, button: MouseButton, count: Int, in target: ResolvedTarget) async throws {
		os.record("\(name).click \(fmt(point)) \(button.rawValue) \(count)")
	}

	func scroll(at point: Point, dx: Double, dy: Double, in target: ResolvedTarget) async throws {
		os.record("\(name).scroll \(fmt(point)) \(Int(dx)) \(Int(dy))")
	}

	func drag(_ path: [Point], ms: Int, in target: ResolvedTarget) async throws {
		os.record("\(name).drag \(path.map(fmt).joined(separator: " ")) \(ms)")
	}

	func type(_ text: String, in target: ResolvedTarget) async throws {
		os.record("\(name).type \(text)")
	}

	func key(_ chord: KeyChord, in target: ResolvedTarget) async throws {
		os.record("\(name).key \(chord.text)")
	}
}

/// Time moves only when the engine sleeps, and delayed changes run as it passes them.
struct FakeClock: Clock {
	let os: FakeOS

	func now() -> Double { os.with { $0.now } }

	func sleep(ms: Double) async throws {
		try Task.checkCancellation()
		let due: [(FakeOS) -> Void] = os.with { os in
			os.now += ms
			let ready = os.timers.filter { $0.at <= os.now }
			os.timers.removeAll { $0.at <= os.now }
			return ready.map(\.run)
		}
		for run in due { os.with { run($0) } }
		await Task.yield()
	}
}

/// Collects a connection's reply lines.
actor Lines: LineOutput {
	var lines: [Data] = []

	func send(_ line: Data) async {
		lines.append(line)
	}

	func json() -> [JSON] {
		lines.compactMap { try? JSONDecoder().decode(JSON.self, from: $0) }
	}
}
