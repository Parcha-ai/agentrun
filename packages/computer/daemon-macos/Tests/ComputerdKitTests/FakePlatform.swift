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
		var keysFirst = false
	}

	let lock = NSRecursiveLock()
	var elements: [Int: Element] = [:] { didSet { told() } }
	var order: [Int] = [] { didSet { told() } }
	var window = UiWindow(id: "7", title: "Notes", bounds: Rect(100, 50, 800, 600)) { didSet { told() } }
	/// False once the app's last window closed: then no target resolves.
	var hasWindow = true { didSet { told() } }
	/// False once the app quit: then it has no window either.
	var running = true
	/// Once set, the next resolve answers the window it had and then swaps in this one, as an app does when its
	/// first-run window gives way to the real one between finding a window and reading it.
	var swapAfterResolve: UiWindow?
	var app = UiApp(id: "com.apple.Notes", name: "Notes", pid: 42)
	var trusted = true
	var screenRecording = true
	var focusedID: Int? { didSet { told() } }
	/// An app that ignores a request to focus an element: the request succeeds and the focus stays where it was.
	var ignoresFocus = false
	/// The pid of the app in front; the fake app is pid 42.
	var frontPID: Int32?
	/// Where the pointer is, in screen pixels.
	var cursor = Point(10, 10)
	/// When, on the fake clock, a person last used the keyboard or the mouse.
	var personPressed: Double?
	/// The app's key window, by id; nil for none known.
	var keyWindow: String?
	/// Raw input events the fake refuses, as their entries.
	var rawFails: Set<String> = []
	/// The app in front, as apps.list says it.
	var front = "com.apple.Safari"
	var frameHash = 0
	var maxNodes: Int?
	/// Walks of the tree, and the elements whose actions and settable were read: on a Mac, those two reads cost as much
	/// as the rest of a node.
	var snapshots = 0
	var detailReads = 0
	/// What one walk costs on the clock: System Settings' took 250 to 700 ms on CI.
	var walkMs: Double = 0
	/// Run at the start of every walk, as an app that rebuilds part of its tree each time it is read (System Settings'
	/// sidebar rows scrolled out of view).
	var onSnapshot: ((FakeOS) -> Void)?
	/// Called on every perform, set and post, so a test makes the UI react.
	var react: ((String, FakeOS) -> Void)?
	var log: [String] = []
	var now: Double = 0
	/// Delayed changes: at a time, run this.
	var timers: [(at: Double, run: (FakeOS) -> Void)] = []
	/// The app tells its tree's changes (an AXObserver on a Mac): the platform has Changes, and each change to the tree,
	/// the focus or the window is told at the clock time it is made.
	var tells = false
	/// When the app last told a change.
	var toldAt: Double?
	/// Watches begun, as the platform's Changes counts them.
	var watched: Set<Int32> = []

	func told() {
		if tells { toldAt = now }
	}

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

	/// Runs the delayed changes due by `end` in time order, each at its own time, and leaves the clock at `end`.
	func pass(to end: Double) {
		while let run: (FakeOS) -> Void = with({ os in
			guard let next = os.timers.indices.filter({ os.timers[$0].at <= end }).min(by: { os.timers[$0].at < os.timers[$1].at }) else { return nil }
			let timer = os.timers.remove(at: next)
			os.now = max(os.now, timer.at)
			return timer.run
		}) {
			with { run($0) }
		}
		with { $0.now = end }
	}

	func record(_ entry: String) {
		with { os in os.log.append(entry) }
		react?(entry, self)
	}

	var entries: [String] { with { $0.log } }

	func platform(background: Feature = .on, foreground: Feature = .on) -> Platform {
		Platform(accessibility: FakeAX(os: self), capture: FakeCapture(os: self), workspace: FakeWorkspace(os: self), background: FakeRoute(os: self, name: "bg"), backgroundFeature: background, foreground: FakeRoute(os: self, name: "fg"), foregroundFeature: foreground, raw: FakeRaw(os: self), person: FakePerson(os: self), clock: FakeClock(os: self), changes: with { $0.tells } ? FakeChanges(os: self) : nil)
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
	var openAction: String { "AXOpen" }
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

	func snapshot(_ target: ResolvedTarget, maxNodes: Int, details: Bool) throws -> Snapshot {
		try os.with { os in
			if target.window.id != os.window.id { throw RPCError.notFound("\(os.app.id) has no window \(target.window.id) any more: observe again") }
			os.snapshots += 1
			// What the app remakes as it is read (onSnapshot) is in the walk, and told as it ends; a delayed change due
			// while the walk runs is made then, missing from it.
			let (start, end) = (os.now, os.now + os.walkMs)
			os.now = end
			os.onSnapshot?(os)
			defer {
				os.now = start
				os.pass(to: end)
			}
			let cap = min(maxNodes, os.maxNodes ?? maxNodes)
			var index: [Int: Int] = [:]
			var nodes: [RawNode] = []
			for id in os.order.prefix(cap) {
				let e = os.elements[id]!
				var flags = e.flags
				if os.focusedID == id { flags.insert(.focused) }
				index[id] = nodes.count
				nodes.append(RawNode(handle: ElementHandle(id), role: e.role, name: e.name, value: e.value, desc: e.desc, frame: e.frame, parent: e.parent.flatMap { index[$0] }, flags: flags, actions: details ? e.actions : [], settable: details && e.settable, textInput: e.textInput, keysFirst: e.keysFirst))
			}
			if details { os.detailReads += nodes.count }
			return Snapshot(nodes: nodes, truncated: os.order.count > cap)
		}
	}

	func details(_ element: ElementHandle) -> (actions: [String], settable: Bool) {
		os.with { os in
			os.detailReads += 1
			let e = os.elements[id(element)]
			return (e?.actions ?? [], e?.settable == true)
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
		os.with { if !$0.ignoresFocus { $0.focusedID = id(element) } }
		os.record("ax.focus \(id(element))")
	}

	func select(_ element: ElementHandle) throws -> ElementHandle {
		let ok = os.with { $0.elements[id(element)]?.selectable == true }
		guard ok else { throw RouteUnavailable("not selectable") }
		_ = os.with { $0.elements[id(element)]?.flags.insert(.selected) }
		os.record("ax.select \(id(element))")
		return element
	}

	func isSelected(_ element: ElementHandle) -> Bool { os.with { $0.elements[id(element)]?.flags.contains(.selected) == true } }

	func scrollToVisible(_ element: ElementHandle) throws {
		os.record("ax.scrolltovisible \(id(element))")
	}

	func focused(_ target: ResolvedTarget) -> ElementHandle? { os.with { $0.focusedID }.map { ElementHandle($0) } }

	func takesText(_ element: ElementHandle) -> Bool { os.with { $0.elements[id(element)]?.textInput == true } }

	func keyWindow(_ target: ResolvedTarget) -> String? { os.with { $0.keyWindow } }

	func menuItem(for chord: KeyChord, in target: ResolvedTarget) -> ElementHandle? {
		os.with { os in
			os.order.compactMap { os.elements[$0] }.first { $0.role == "menuitem" && $0.name == chord.text }.map { ElementHandle($0.id) }
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

	func cursor() -> Point? { os.with { $0.cursor } }
}

/// A person's keyboard and mouse, as the test sets them.
struct FakePerson: PersonInput {
	let os: FakeOS

	func lastInput() -> Double? { os.with { $0.personPressed } }
}

/// The keyboard and mouse: each event recorded, the pointer kept (in pixels, at scale 2), and a raw.fail entry's event
/// thrown instead.
struct FakeRaw: RawInput {
	let os: FakeOS

	func num(_ d: Double) -> String { d == d.rounded() ? "\(Int(d))" : "\(d)" }

	func fmt(_ p: Point) -> String { "\(num(p.x)),\(num(p.y))" }

	/// As the Mac's input queue does, a cancelled task posts nothing.
	func post(_ entry: String) throws {
		if Task.isCancelled { throw CancellationError() }
		if os.with({ $0.rawFails.contains(entry) }) { throw RPCError.invalid("the fake refused \(entry)") }
		os.record(entry)
	}

	func move(to point: Point, held: Set<InputButton>) async throws {
		try post("raw.move \(fmt(point))\(held.isEmpty ? "" : " " + held.map(\.rawValue).sorted().joined(separator: ","))")
		os.with { $0.cursor = Point(point.x * 2, point.y * 2) }
	}

	func button(_ button: InputButton, down: Bool, at point: Point, clickState: Int) async throws {
		try post("raw.\(down ? "down" : "up") \(button.rawValue) \(fmt(point)) \(clickState)")
	}

	func scroll(at point: Point, dx: Double, dy: Double, pixels: Bool) async throws {
		try post("raw.scroll \(fmt(point)) \(num(dx)) \(num(dy)) \(pixels ? "px" : "clicks")")
	}

	func key(_ key: String, down: Bool) async throws {
		try post("raw.key \(key) \(down ? "down" : "up")")
	}

	func type(_ text: String) async throws {
		try post("raw.type \(text)")
	}
}

struct FakeWorkspace: Workspace {
	let os: FakeOS

	var backgroundLaunch: Feature { .on }

	var frontmost: Int32? { os.with { $0.frontPID } }

	func running(_ id: String) -> Bool { os.with { $0.running && $0.app.id == id } }

	func list() -> AppsListResult {
		AppsListResult(apps: [App(id: "com.apple.Notes", name: "Notes"), App(id: "com.apple.Safari", name: "Safari")], foreground: os.with { $0.front })
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

/// Time moves only when the engine sleeps, and delayed changes run as it passes them, each at its own time.
struct FakeClock: Clock {
	let os: FakeOS

	func now() -> Double { os.with { $0.now } }

	func sleep(ms: Double) async throws {
		try Task.checkCancellation()
		os.pass(to: os.with { $0.now + ms })
		await Task.yield()
	}
}

/// The app's changes as it tells them: FakeOS.toldAt.
struct FakeChanges: Changes {
	let os: FakeOS

	func watch(_ pid: Int32) -> Bool {
		os.with { _ = $0.watched.insert(pid) }
		return true
	}

	func lastChange(_ pid: Int32) -> Double? { os.with { $0.toldAt } }
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
