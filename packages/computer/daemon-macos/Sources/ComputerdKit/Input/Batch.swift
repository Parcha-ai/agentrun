import Foundation

/// One input.actions call: the batch checked whole, then run on the computer's own keyboard and mouse in order until
/// the first failure. Raw input takes the person's real pointer and lands on the app in front, so it is foreground
/// input: it needs the same grant as ui's foreground route (Platform.foregroundFeature), the app in front must be one
/// the owner's Policy allows, and a person who uses the keyboard or the mouse during a batch stops it (aborted,
/// TakeOverWatch: a ui act's rule too), with what it held released.
public struct InputBatch: Sendable {
	let platform: Platform
	let policy: Policy
	let groups: [Group]
	let held: InputHeld

	/// `held` is what this connection's earlier batches left down; the Driver gives every batch of a connection its one.
	public init(platform: Platform, policy: Policy, groups: [Group], held: InputHeld = InputHeld()) {
		self.platform = platform
		self.policy = policy
		self.groups = groups
		self.held = held
	}

	public func run(_ raw: JSON) async throws -> InputActionsResult {
		let (actions, failed) = InputCheck.check(raw, groups: groups)
		if let failed { return InputActionsResult(done: 0, failed: failed) }
		if actions.isEmpty { return InputActionsResult(done: 0) }
		if case .off(let reason) = platform.foregroundFeature {
			throw RPCError.denied("input.actions is this computer's own keyboard and mouse, and \(reason)")
		}
		guard let screen = platform.capture.screenInfo() else { throw RPCError.unsupported("input.actions: no display is attached") }
		let (platform, policy, held) = (self.platform, self.policy, self.held)
		return try await InputGate.shared.serial {
			// What an earlier batch left down stays down for this one, so a move is a drag and a failure lets go of it.
			let (buttons, keys) = held.get()
			let run = InputRun(platform: platform, policy: policy, screen: screen, buttons: buttons, keys: keys)
			do {
				let result = try await run.run(actions)
				held.set(buttons: run.buttons, keys: run.keys)
				return result
			} catch {
				held.set(buttons: run.buttons, keys: run.keys)
				throw error
			}
		}
	}

	/// Lets go of what earlier batches left held: the connection ended, and nobody is left to release it.
	public func releaseHeld() async {
		guard let screen = platform.capture.screenInfo() else { return }
		let (platform, held) = (self.platform, self.held)
		try? await InputGate.shared.serial {
			let (buttons, keys) = held.get()
			if buttons.isEmpty && keys.isEmpty { return }
			let run = InputRun(platform: platform, policy: Policy(), screen: screen, buttons: buttons, keys: keys)
			await run.release()
			held.set(buttons: run.buttons, keys: run.keys)
		}
	}
}

/// The buttons and keys a connection's batches have pressed and not released.
public final class InputHeld: @unchecked Sendable {
	private let lock = NSLock()
	private var buttons: [InputButton] = []
	private var keys: [String] = []

	public init() {}

	func get() -> ([InputButton], [String]) { lock.withLock { (buttons, keys) } }

	func set(buttons: [InputButton], keys: [String]) {
		lock.withLock {
			self.buttons = buttons
			self.keys = keys
		}
	}
}

/// One batch at a time on this computer: two interleaved would be one garbled gesture.
actor InputGate {
	static let shared = InputGate()
	private var busy = false
	private var waiting: [CheckedContinuation<Void, Never>] = []

	func serial<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
		if busy {
			await withCheckedContinuation { waiting.append($0) }
		} else {
			busy = true
		}
		defer {
			if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
		}
		return try await body()
	}
}

/// A failure of one action: its kind and why.
struct InputStop: Error {
	var kind: ErrorKind
	var why: String

	init(_ kind: ErrorKind, _ why: String) {
		self.kind = kind
		self.why = why
	}
}

/// A batch running: the screen in pixels, what it pressed and has not released, and where it left the pointer.
final class InputRun: @unchecked Sendable {
	/// The longest leg one drag event moves, in points; a longer leg is cut into pieces about 8 ms apart.
	static let dragStepPoints = 20.0
	/// The most one raw scroll call sends, in points or in clicks, and one raw type call, in characters: the app in
	/// front is checked, and a cancel looked for, between calls.
	static let scrollBurstPoints = 400.0
	static let scrollBurstClicks = 20.0
	static let typeBurstCharacters = 32

	let platform: Platform
	let policy: Policy
	let raw: any RawInput
	let clock: any Clock
	let width: Int
	let height: Int
	let scale: Double
	var buttons: [InputButton]
	var keys: [String]
	/// Where the batch's last pointer action left the pointer, in pixels: where the take-over check holds it.
	var left: Pixel? {
		didSet { if let left { takeOver.pointer = Point(Double(left.x), Double(left.y)) } }
	}
	/// A person at the keyboard or the mouse since the batch began stops it before its next action.
	var takeOver: TakeOverWatch

	init(platform: Platform, policy: Policy, screen: ScreenInfo, buttons: [InputButton] = [], keys: [String] = []) {
		self.buttons = buttons
		self.keys = keys
		self.platform = platform
		self.policy = policy
		takeOver = TakeOverWatch(call: "batch", unit: "action", platform: platform)
		raw = platform.raw
		clock = platform.clock
		scale = screen.scale > 0 ? screen.scale : 1
		width = Int((screen.width * scale).rounded())
		height = Int((screen.height * scale).rounded())
	}

	func run(_ actions: [InputAction]) async throws -> InputActionsResult {
		for (i, a) in actions.enumerated() {
			do {
				try Task.checkCancellation()
				try guardFront()
				try takeOver.check(platform)
				try await run(a)
			} catch let taken as TakenOver {
				await release()
				return InputActionsResult(done: i, failed: InputFailure(i, .aborted, "action \(i) (\(a.type)): \(taken.message)"))
			} catch let stop as InputStop {
				await release()
				return InputActionsResult(done: i, failed: InputFailure(i, stop.kind, "action \(i) (\(a.type)): \(stop.why)"))
			} catch is CancellationError {
				await release()
				throw RPCError(.aborted, "input.actions was cancelled in action \(i); what the batch held was released")
			} catch let error as RPCError {
				await release()
				return InputActionsResult(done: i, failed: InputFailure(i, error.kind, "action \(i) (\(a.type)): \(error.message)"))
			} catch {
				await release()
				return InputActionsResult(done: i, failed: InputFailure(i, .unsupported, "action \(i) (\(a.type)): \(error)"))
			}
		}
		return InputActionsResult(done: actions.count)
	}

	/// Raw input lands on the app in front: with an owner's list of apps, that app must be on it.
	func guardFront() throws {
		guard let allowed = policy.apps else { return }
		let front = platform.workspace.list().foreground
		guard let front, policy.allows(front) else {
			throw InputStop(.denied, "input goes to the app in front, \(front ?? "none"), and this computer's owner allows Computerd to touch only \(allowed.joined(separator: ", "))")
		}
	}

	func inside(_ p: Pixel) throws {
		guard p.x >= 0, p.y >= 0, p.x < width, p.y < height else {
			throw InputStop(.invalid, "(\(p.x), \(p.y)) is outside the \(width)x\(height) screen")
		}
	}

	func point(_ p: Pixel) -> Point { Point(Double(p.x) / scale, Double(p.y) / scale) }

	/// Where the pointer is now, in points.
	var cursor: Point {
		if let at = platform.capture.cursor() { return Point(at.x / scale, at.y / scale) }
		return left.map(point) ?? Point(0, 0)
	}

	func pause(_ ms: Double) async throws { try await clock.sleep(ms: ms) }

	func move(_ p: Pixel) async throws {
		try inside(p)
		try await raw.move(to: point(p), held: Set(buttons))
		left = p
	}

	func press(_ button: InputButton, down: Bool, clickState: Int = 1) async throws {
		// Where the batch left the pointer (the take-over check holds it there), else where it is.
		try await raw.button(button, down: down, at: left.map(point) ?? cursor, clickState: clickState)
		if down { buttons.append(button) } else { buttons.removeAll { $0 == button } }
	}

	func key(_ name: String, down: Bool) async throws {
		try await raw.key(name, down: down)
		if down {
			keys.append(name)
		} else if let i = keys.lastIndex(of: name) {
			keys.remove(at: i)
		}
	}

	/// Presses names in order, runs then, and releases them in reverse.
	func holding(_ names: [String], _ then: () async throws -> Void) async throws {
		var pressed: [String] = []
		for name in names where !pressed.contains(name) {
			try await key(name, down: true)
			pressed.append(name)
		}
		try await then()
		for name in pressed.reversed() { try await key(name, down: false) }
	}

	func run(_ a: InputAction) async throws {
		switch a.type {
		case "move":
			try await move(a.at!)
		case "down":
			try await press(a.button, down: true)
		case "up":
			try await press(a.button, down: false)
		case "click":
			if let at = a.at { try inside(at) }
			try await holding(a.keys) {
				if let at = a.at {
					try await move(at)
					try await pause(15)
				}
				for n in 1...a.count {
					try Task.checkCancellation()
					try guardFront()
					try await press(a.button, down: true, clickState: n)
					try await pause(1)
					try await press(a.button, down: false, clickState: n)
					if n < a.count { try await pause(80) }
				}
			}
		case "drag":
			for p in a.path { try inside(p) }
			try await holding(a.keys) {
				try await move(a.path[0])
				try await pause(15)
				try await press(a.button, down: true)
				var from = point(a.path[0])
				for p in a.path.dropFirst() {
					let to = point(p)
					let pieces = max(1, Int((hypot(to.x - from.x, to.y - from.y) / Self.dragStepPoints).rounded(.up)))
					for k in 1...pieces {
						try Task.checkCancellation()
						try guardFront()
						try await pause(8)
						let t = Double(k) / Double(pieces)
						try await raw.move(to: Point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t), held: Set(buttons))
					}
					left = p
					from = to
				}
				try await pause(15)
				try await press(a.button, down: false)
			}
		case "scroll":
			if let at = a.at { try inside(at) }
			try await holding(a.keys) {
				if let at = a.at {
					try await move(at)
					try await pause(15)
				}
				// Pixels of the screenshot are points times scale; clicks are clicks.
				let (dx, dy) = a.pixels ? (a.dx / scale, a.dy / scale) : (a.dx, a.dy)
				// In bursts, so the app in front is checked between them and a cancel stops the scroll.
				let burst = a.pixels ? Self.scrollBurstPoints : Self.scrollBurstClicks
				var (left, down) = (dx, dy)
				repeat {
					try Task.checkCancellation()
					try guardFront()
					let sx = max(-burst, min(burst, left))
					let sy = max(-burst, min(burst, down))
					try await raw.scroll(at: cursor, dx: sx, dy: sy, pixels: a.pixels)
					left -= sx
					down -= sy
				} while left != 0 || down != 0
			}
		case "key":
			for _ in 0..<a.repeats {
				try Task.checkCancellation()
				try guardFront()
				try await holding(a.keys) {}
				try await pause(2)
			}
		case "hold":
			try await holding(a.keys) { try await pause(Double(a.ms)) }
		case "type":
			// In bursts, so the app in front is checked between them and a cancel stops the text.
			let characters = Array(a.text)
			var start = 0
			repeat {
				try Task.checkCancellation()
				try guardFront()
				let end = min(start + Self.typeBurstCharacters, characters.count)
				try await raw.type(String(characters[start..<end]))
				start = end
			} while start < characters.count
		case "wait":
			try await pause(Double(a.ms))
		default:
			throw InputStop(.unsupported, "\(a.type) is not an action this computer runs")
		}
	}

	/// Lets go of every key and button the batch holds, keys last pressed first. A cancelled batch releases too: the
	/// releases run in a task of their own, which the request's cancel never reaches, so every key-up and button-up
	/// posts (the Mac's input queue posts nothing for a cancelled task). Each leaves the held state only once its
	/// release posted, so one that failed is still held for the connection's close to let go.
	func release() async {
		await Task.detached { [self] in
			for name in keys.reversed() {
				guard (try? await raw.key(name, down: false)) != nil else { continue }
				if let i = keys.lastIndex(of: name) { keys.remove(at: i) }
			}
			let at = cursor
			for button in buttons.reversed() {
				guard (try? await raw.button(button, down: false, at: at, clickState: 1)) != nil else { continue }
				if let i = buttons.lastIndex(of: button) { buttons.remove(at: i) }
			}
		}.value
	}
}
