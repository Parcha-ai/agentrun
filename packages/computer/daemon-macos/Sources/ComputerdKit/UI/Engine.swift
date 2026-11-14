import Foundation

/// A route sent nothing for this step here, so the next route may try: the element takes no press, the
/// window would not become key. A refusal that ends the step (stale, denied) is an RPCError instead.
public struct RouteUnavailable: Error, Sendable {
	public let reason: String

	public init(_ reason: String) {
		self.reason = reason
	}
}

/// The timings the engine settles and polls by.
public struct Timing: Sendable {
	/// Two looks this far apart that are the same count as settled.
	public var quietMs: Double = 150
	/// The longest one settle waits.
	public var settleMaxMs = Double(Limits.maxSettleMs)
	/// How often an expect looks again.
	public var expectPollMs: Double = 100
	/// At an app that tells its changes, how long an expect waits for one before it reads the window anyway: an app may
	/// change its window without telling it.
	public var untoldMs: Double = 1000
	/// How long after the act's first final view a set value must still hold to count as verified.
	public var setHoldMs = Double(Limits.setHoldMs)
	/// Told one line per act: each step's route and ms with the looks its settle took, the expect's ms, and the time a
	/// look takes. The Mac app writes it to its log.
	public var trace: (@Sendable (String) -> Void)?

	public init(trace: (@Sendable (String) -> Void)? = nil) {
		self.trace = trace
	}
}

/// The ui group for one connection: observe and act on apps through a Platform, under the owner's Policy. The rules are
/// the ones every driver keeps (spec/computer/wire.md, "The ui group"; packages/computer/src/ui-engine.ts): a ref stays
/// good while its element exists; a point is bound to the state it was read from; every step settles before the next;
/// an expect is polled on the computer; a feature that is off is refused with its reason. Calls run one at a time.
public actor UIEngine {
	let platform: Platform
	let policy: Policy
	let timing: Timing
	var store = StateStore()
	var busy = false
	var waiting: [CheckedContinuation<Void, Never>] = []
	/// Where an act's time went, for timing.trace: looks taken, their ms, and the ms of the image hashes among them.
	var looks = 0
	var lookMs = 0.0
	var frameMs = 0.0
	/// The act running now, for the take-over check (TakeOverWatch, input.actions' rule too). Armed once a step took the
	/// foreground route: from then on every step checks.
	var takeOver: TakeOverWatch?
	var takeOverArmed = false
	/// The running step's mark (Marks), which only that step moves.
	var stepMark: UInt64?
	/// The apps whose changes the platform tells (Platform.changes), by id: the pid the engine watches.
	var watched: [String: Int32] = [:]
	/// The engine's latest read of a window whose app tells its changes, and the target it was asked for.
	var latest: (asked: Target?, view: View)?

	public init(platform: Platform, policy: Policy, timing: Timing = Timing()) {
		self.platform = platform
		self.policy = policy
		self.timing = timing
	}

	var ax: any Accessibility { platform.accessibility }
	var clock: any Clock { platform.clock }

	/// Runs calls one at a time in arrival order, so one act's steps never interleave with another's.
	func inTurn<T: Sendable>(_ body: () async throws -> T) async throws -> T {
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

	// MARK: looking

	/// A look at the target's window, under the policy. With ui.tree off it is the window alone, found in the window
	/// server's list, with no nodes; with ui.image off as well there is nothing to look with. The image's hash is read
	/// when there are no nodes, or when framed (a look kept as a state): reading it is a window capture, the slow part.
	/// Only an observe's look reads every node's actions and settable (details): an act reads them for the elements its
	/// steps act on, when each step runs.
	func look(_ target: Target?, framed: Bool = false, details: Bool = false) async throws -> View {
		let start = clock.now()
		defer {
			looks += 1
			lookMs += clock.now() - start
		}
		if let app = target?.app { try policy.check(app) }
		let resolved: ResolvedTarget
		let snapshot: Snapshot
		var at: Double?
		switch (ax.feature, platform.capture.feature) {
		case (.on, _):
			var found = try ax.resolve(target)
			try policy.check(found.app.id)
			at = watch(found)
			do {
				snapshot = try ax.snapshot(found, maxNodes: Limits.maxUiNodes, details: details)
			} catch let gone as RPCError where gone.kind == .notFound && target?.window == nil {
				// A target that names no window is the app's main one: when the app swapped it between finding and
				// reading it (a first-run window giving way to the real one), the look follows the new main window.
				found = try ax.resolve(target)
				try policy.check(found.app.id)
				at = watch(found)
				snapshot = try ax.snapshot(found, maxNodes: Limits.maxUiNodes, details: details)
			}
			resolved = found
		case (.off, .on):
			resolved = try platform.capture.resolve(target)
			try policy.check(resolved.app.id)
			snapshot = Snapshot(nodes: [], truncated: false)
		case (.off(let tree), .off(let image)):
			throw RPCError.denied("ui.tree is off here: \(tree); and ui.image is off: \(image). Without either, Computerd cannot see a window")
		}
		let view = View(target: resolved, nodes: snapshot.nodes, truncated: snapshot.truncated, frame: nil, at: at)
		let answer = framed || snapshot.nodes.isEmpty ? await self.framed(view) : view
		latest = at == nil ? nil : (target, answer)
		return answer
	}

	/// Watches the app's changes, where the platform tells them, before its window is read: the time the read begins,
	/// after which every change is told. nil for an app that tells none.
	func watch(_ found: ResolvedTarget) -> Double? {
		guard let changes = platform.changes, changes.watch(found.pid) else {
			watched[found.app.id] = nil
			return nil
		}
		watched[found.app.id] = found.pid
		return clock.now()
	}

	/// The app told a change at `time` or after; true where the platform tells none.
	func told(_ pid: Int32, since time: Double) -> Bool {
		guard let changes = platform.changes else { return true }
		return (changes.lastChange(pid) ?? -.infinity) >= time
	}

	/// The engine's latest read of the window a target names, when it was asked for by the same target (one that names
	/// its app) and the app told no change since the read began: what an observe just before an act read, for the act's
	/// first look.
	func unchanged(_ target: Target?) -> View? {
		guard target?.app != nil, let (asked, view) = latest, asked == target, let at = view.at, !told(view.target.pid, since: at) else { return nil }
		return view
	}

	/// The look with its image's hash, read now if it has none.
	func framed(_ view: View) async -> View {
		guard view.frame == nil, platform.capture.feature.isOn else { return view }
		let start = clock.now()
		let frame = await platform.capture.windowHash(view.target)
		frameMs += clock.now() - start
		return view.with(frame: frame)
	}

	// MARK: observe

	/// Room a reply keeps for everything but its nodes and image.
	static let replyRoom = 16 * 1024

	public func observe(_ params: UiObserveParams) async throws -> UiObserveResult {
		try await inTurn { try await observeNow(params) }
	}

	func observeNow(_ params: UiObserveParams) async throws -> UiObserveResult {
		var edge: Int?
		if case .image(let given)? = params.image {
			edge = given ?? Limits.defaultImageEdge
			if let given, !(Limits.minImageEdge...Limits.maxImageEdge).contains(given) {
				throw RPCError.limit("ui.observe: image.maxEdge \(given) is outside \(Limits.minImageEdge) to \(Limits.maxImageEdge) pixels")
			}
			if case .off(let reason) = platform.capture.feature {
				throw RPCError.unsupported("ui.observe: ui.image is off here: \(reason)")
			}
		}
		// With the tree off the image is all a caller has to act from, so it comes asked for or not.
		var empty: String?
		if case .off(let reason) = ax.feature {
			empty = "ui.tree is off here: \(reason)"
			edge = edge ?? Limits.defaultImageEdge
		}
		let view = try await look(params.target, framed: true, details: true)
		var image: UiImage?
		if let edge {
			let shot = try await platform.capture.window(view.target, maxEdge: edge, maxBytes: Limits.maxChunkBytes)
			guard shot.data.count <= Limits.maxChunkBytes else {
				throw RPCError.limit("ui.observe: the window's image is \(shot.data.count) bytes, over \(Limits.maxChunkBytes): ask for a smaller maxEdge")
			}
			image = UiImage(format: shot.format, width: shot.width, height: shot.height, data: shot.data)
		}
		try Task.checkCancellation()
		var (nodes, truncated) = self.nodes(view, full: params.full ?? false)
		// The image is whole, so nodes give way to keep the reply within the line limit.
		let room = Limits.maxLineBytes - Self.replyRoom - (image.map { ($0.data.count + 2) / 3 * 4 } ?? 0)
		while !nodes.isEmpty, ((try? Coders.encode(nodes))?.count ?? 0) > room {
			nodes = Array(nodes.prefix(nodes.count * 9 / 10))
			truncated = true
		}
		let diff = params.since.flatMap { store.view($0) }.map { self.diff(from: $0, to: view, shown: nodes) }
		let state = store.add(view)
		return UiObserveResult(state: state, app: view.target.app, window: view.target.window, nodes: nodes, diff: diff, image: image, empty: empty, truncated: truncated || view.truncated)
	}

	/// Roles a person acts on: kept in a compact view even without a name.
	static let actionable: Set<String> = ["button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "slider", "combobox", "menuitem", "tab", "listitem", "scrollarea"]

	/// A compact view keeps what can be acted on and what has words, and every node above those, so each node's parent
	/// is in the list.
	func keeps(_ node: RawNode) -> Bool {
		if node.flags.contains(.focused) || node.settable || node.textInput { return true }
		if Self.actionable.contains(node.role) { return true }
		if node.actions.contains(where: { !ax.incidentalActions.contains($0) }) { return true }
		return !(node.name ?? "").isEmpty || !(node.value ?? "").isEmpty || !(node.desc ?? "").isEmpty
	}

	/// The view's nodes as the wire sends them, compact or full, at most maxUiNodes.
	func nodes(_ view: View, full: Bool) -> ([UiNode], Bool) {
		var kept = [Bool](repeating: full, count: view.nodes.count)
		if !full {
			for (i, node) in view.nodes.enumerated() where keeps(node) {
				var at: Int? = i
				while let j = at, !kept[j] {
					kept[j] = true
					at = view.nodes[j].parent
				}
			}
		}
		var out: [UiNode] = []
		var refOf: [Int: String] = [:]
		var truncated = false
		let window = Rect(0, 0, view.target.window.bounds.w, view.target.window.bounds.h)
		for (i, node) in view.nodes.enumerated() where kept[i] {
			guard out.count < Limits.maxUiNodes else {
				truncated = true
				break
			}
			let ref = store.ref(for: node)
			refOf[i] = ref
			var parent = node.parent
			while let p = parent, refOf[p] == nil { parent = view.nodes[p].parent }
			let bounds = view.bounds(node)
			var flags = node.flags
			if node.frame == nil || !window.intersects(bounds) { flags.insert(.offscreen) }
			out.append(UiNode(
				ref: ref, role: node.role, name: Self.words(node.name),
				value: flags.contains(.secure) ? nil : Self.words(node.value), desc: Self.words(node.desc), id: Self.words(node.identifier),
				bounds: bounds, parent: parent.flatMap { refOf[$0] },
				flags: flags.isEmpty ? nil : flags.sorted(), actions: node.actions.isEmpty ? nil : node.actions))
		}
		return (out, truncated)
	}

	static func words(_ s: String?) -> String? {
		s.flatMap { $0.isEmpty ? nil : $0 }
	}

	/// What changed since an older look: nodes this result shows that are new or look different, and elements that had
	/// refs then and are gone now.
	func diff(from old: View, to new: View, shown: [UiNode]) -> UiDiff {
		var before: [ElementHandle: String] = [:]
		for node in old.nodes { before[node.handle] = old.looks(node) }
		let now = Set(new.nodes.map(\.handle))
		var added: [String] = []
		var changed: [String] = []
		var byRef: [String: RawNode] = [:]
		for node in new.nodes { if let ref = store.known(node.handle) { byRef[ref] = node } }
		for shownNode in shown {
			guard let node = byRef[shownNode.ref] else { continue }
			guard let was = before[node.handle] else {
				added.append(shownNode.ref)
				continue
			}
			if was != new.looks(node) { changed.append(shownNode.ref) }
		}
		let removed = old.nodes.filter { !now.contains($0.handle) }.compactMap { store.known($0.handle) }
		return UiDiff(added: added, removed: removed, changed: changed)
	}

	// MARK: act

	public func act(_ params: UiActParams) async throws -> UiActResult {
		try validate(params)
		return try await inTurn { try await actNow(params) }
	}

	/// The act's params checked whole, before any step runs.
	func validate(_ p: UiActParams) throws {
		guard p.steps.count <= Limits.maxSteps else {
			throw RPCError.limit("ui.act: \(p.steps.count) steps, more than the \(Limits.maxSteps) one act holds")
		}
		var dragMs = 0
		for (i, step) in p.steps.enumerated() {
			if case .drag(_, let ms) = step { dragMs += ms ?? 0 }
			if case .key(let chord) = step {
				do { _ = try KeyChord.parse(chord) } catch let e as RPCError { throw RPCError.invalid("ui.act: steps[\(i)]: \(e.message)") }
			}
			if step.point != nil && p.state == nil {
				throw RPCError.invalid("ui.act: steps[\(i)] is at a point, and a point needs the state it was read from: pass state")
			}
		}
		guard dragMs <= Limits.maxBatchWaitMs else {
			throw RPCError.limit("ui.act: the drags ask for \(dragMs) ms, more than the \(Limits.maxBatchWaitMs) ms one act may")
		}
		if let e = p.expect {
			if let wanted = e.window {
				guard e.text == nil && e.ref == nil else {
					throw RPCError.invalid("ui.act: expect.window stands alone: an expect waits for a window, or for text or a ref in the act's window, not both")
				}
				guard wanted.title != nil || wanted.role != nil else { throw RPCError.invalid("ui.act: expect.window names neither title nor role: it needs at least one") }
				if let role = wanted.role, !uiRoles.contains(role) {
					throw RPCError.invalid("ui.act: expect.window.role is \(role.debugDescription), not one of the protocol's roles (uiRoles)")
				}
			} else {
				guard e.text != nil || e.ref != nil else { throw RPCError.invalid("ui.act: expect names neither text, ref nor window: it needs one") }
				// A window expect reads only the window's title and role, which the window list gives with the tree off too.
				if case .off(let reason) = ax.feature {
					throw RPCError.unsupported("ui.act: an expect reads the window's elements, and ui.tree is off here: \(reason)")
				}
			}
			if let ref = e.ref, !isRef(ref) { throw RPCError.invalid("ui.act: expect.ref is \(ref.debugDescription), not a ref (\"@e12\")") }
			if let t = e.timeoutMs {
				guard t >= 0 else { throw RPCError.invalid("ui.act: expect.timeoutMs is not a whole number of milliseconds") }
				guard t <= Limits.maxExpectMs else { throw RPCError.limit("ui.act: expect.timeoutMs \(t) is more than the \(Limits.maxExpectMs) ms an expect may wait") }
			}
		}
		if p.steps.isEmpty && p.expect == nil { throw RPCError.invalid("ui.act has no steps and no expect: nothing to do") }
	}

	func actNow(_ params: UiActParams) async throws -> UiActResult {
		let refs = params.steps.compactMap(\.ref) + [params.expect?.ref].compactMap { $0 }
		if let unknown = refs.first(where: { store.handle($0) == nil }) {
			throw RPCError.invalid("ui.act: \(unknown) is not a ref this connection was given: observe first")
		}
		let held = params.state.flatMap { store.view($0) }
		let target = params.target ?? held.map { Target(app: $0.target.app.id, window: $0.target.window.id) }
		let foreground = params.foreground ?? false
		let waitsForWindow = params.expect?.window != nil

		let started = clock.now()
		(looks, lookMs, frameMs) = (0, 0, 0)
		takeOver = TakeOverWatch(call: "act", unit: "step", platform: platform)
		takeOverArmed = false
		var spent: [String] = []
		// The steps act on the window as the engine last read it, when its app told no change since (an observe just
		// before): the settle after each step reads it again. A wait for a window may begin with none: its app's window
		// not there yet is what it waits for, never not_found.
		let first: View?
		if !params.steps.isEmpty, let unchanged = unchanged(target) {
			first = unchanged
			spent.append("first look unchanged")
		} else {
			do {
				first = try await look(target)
			} catch let none as RPCError where none.kind == .notFound && waitsForWindow && params.steps.isEmpty {
				first = nil
			}
		}
		let app = target?.app ?? first?.target.app.id
		let appName = first?.target.app.name ?? app ?? "the app"
		var aim = Aim(window: first?.target.asTarget ?? target, app: app, windowless: first == nil, waitsForWindow: waitsForWindow)
		var view = first
		/// The look the last step settled on: the act's first final read of its own window.
		var settled: View?
		var results: [StepResult] = []
		var refused = false
		for step in params.steps {
			try Task.checkCancellation()
			guard let current = view else {
				results.append(.error(StepError(kind: .stale, message: "\(appName) has no window left: the step before closed its last one, so this step has nothing to act on")))
				refused = true
				spent.append("\(step.verb) refused: no window left")
				break
			}
			let (at, looked) = (clock.now(), looks)
			do {
				if takeOverArmed { try takeOver?.check(platform) }
				let (route, verified, after) = try await run(step, view: current, state: params.state, held: held, foreground: foreground)
				results.append(.ran(route: route, verified: verified))
				view = after
				settled = after
				if let after { aim.window = after.target.asTarget } else { aim.closed = true }
				spent.append("\(step.verb) \(route.rawValue)\(verified ? "" : " unverified") \(Int(clock.now() - at)) ms, \(looks - looked) looks")
			} catch let error as RPCError where Self.stepKinds.contains(error.kind) {
				results.append(.error(StepError(kind: error.kind, message: error.message)))
				refused = true
				settled = nil
				spent.append("\(step.verb) refused \(error.kind.rawValue) \(Int(clock.now() - at)) ms")
				break
			} catch let taken as TakenOver {
				results.append(.error(StepError(kind: .aborted, message: taken.message)))
				refused = true
				spent.append("\(step.verb) aborted: a person took over")
				break
			}
		}

		var read = try await final(&aim, reuse: refused ? nil : settled, from: params.steps.isEmpty ? first : nil)
		// A set holds: the final view is read again setHoldMs after the first, where an app that took the value back (the
		// Finder's name field outside its rename mode shows the new name, then the old one, and renames nothing) answers
		// false. The hold is waited out even when the window closed: a value that cannot be read after it is not verified.
		let sets = params.steps.indices.filter { index in
			guard case .set = params.steps[index], index < results.count, case .ran(_, true) = results[index] else { return false }
			return true
		}
		if !sets.isEmpty {
			try await sleep(timing.setHoldMs)
			read = try await final(&aim)
		}
		var outcome: ExpectOutcome?
		let expectAt = clock.now()
		if let expect = params.expect, !refused {
			let until = clock.now() + Double(expect.timeoutMs ?? Limits.defaultExpectMs)
			while true {
				// A window expect reads the app's main window; any other, the act's window.
				if holds(expect, waitsForWindow ? read.front : read.own) {
					outcome = .met
					break
				}
				// A window that closed shows nothing again: what it held is gone, and what it did not hold never comes.
				if aim.closed || clock.now() >= until {
					outcome = .unmet
					break
				}
				// At an app that tells its changes, wait for one, then read the final view once the app went quiet: a
				// read takes the app's own thread, and System Settings, read back to back, drew About 2.5 to 4 s after
				// the click.
				if try await awaitTold(waitsForWindow ? read.front : read.own, until: until) {
					read = try await final(&aim)
					continue
				}
				// Poll with quick looks until one holds, the window closes or the time is up; then read the final view
				// again, so a look caught mid-transition never decides the act.
				while true {
					try await sleep(min(timing.expectPollMs, max(1, until - clock.now())))
					let looked = waitsForWindow ? try await frontLook(aim, settled: false) : try await aimed(&aim, settled: false)
					if aim.closed || clock.now() >= until || holds(expect, looked) { break }
				}
				read = try await final(&aim)
			}
			spent.append("expect \(outcome!.rawValue) \(Int(clock.now() - expectAt)) ms")
		}
		let own = read.own
		for index in sets {
			guard case .set(let ref, let value) = params.steps[index], case .ran(let route, _) = results[index] else { continue }
			if own.map({ setHolds(ref, value, $0) }) != true { results[index] = .ran(route: route, verified: false) }
		}
		// A met window expect answers the window that met it; every other act answers its own window.
		guard !aim.closed, let answered = waitsForWindow && outcome == .met ? read.front : own else {
			trace(app ?? "the app in front", since: started, spent)
			return UiActResult(steps: results, state: nil, window: "closed", changed: true, expect: outcome)
		}
		// A state keeps its image's hash, for a later point with no element under it.
		let answer = await framed(answered)
		let state = store.add(answer)
		trace(answer.target.app.id, since: started, spent)
		return UiActResult(steps: results, state: state, changed: first.map { $0.fingerprint != answer.fingerprint } ?? true, expect: outcome)
	}

	/// Tells timing.trace where the act's time went.
	func trace(_ app: String, since started: Double, _ spent: [String]) {
		guard let trace = timing.trace else { return }
		let each = looks > 0 ? Int(lookMs / Double(looks)) : 0
		trace("ui.act \(app): \(Int(clock.now() - started)) ms; \(spent.joined(separator: "; ")); \(looks) looks, \(each) ms each, \(Int(frameMs)) ms of image hashes")
	}

	/// Where an act's looks go after its first. Every later look is of the window the first one found, even if another
	/// app comes to the front; once a step closes it, of the app's next main window (follow); once the app has no
	/// window left, of none, and the act answers window "closed". A wait that began with no window keeps its target: it
	/// never follows and never ends as closed.
	struct Aim {
		var window: Target?
		/// The act's app: a window expect reads its main window, and a closed window hands the act to its next one.
		let app: String?
		var closed = false
		let windowless: Bool
		let waitsForWindow: Bool

		init(window: Target?, app: String?, windowless: Bool, waitsForWindow: Bool) {
			self.window = window
			self.app = app
			self.windowless = windowless
			self.waitsForWindow = waitsForWindow
		}

		/// Where a window expect looks: the app's main window, whichever it is now, never the window the act aimed at.
		var front: Target? { app.map { Target(app: $0, window: nil) } }
	}

	/// The act's own window, settled or one look: the aimed one, or the app's next main window once it closed (which
	/// the act then follows); nil when none is left.
	func aimed(_ aim: inout Aim, settled: Bool, from first: View? = nil) async throws -> View? {
		if aim.closed { return nil }
		let window = aim.window
		do {
			return settled ? try await settle(window, from: first) : try await look(window)
		} catch let none as RPCError where none.kind == .notFound {
			if aim.windowless { return nil }
			guard let app = aim.app else { throw none }
			guard let next = try await follow(app, settled: settled) else {
				aim.closed = true
				return nil
			}
			aim.window = next.target.asTarget
			return next
		}
	}

	/// The app's main window, settled or one look; nil when the app shows none.
	func frontLook(_ aim: Aim, settled: Bool) async throws -> View? {
		let front = aim.front
		do {
			return settled ? try await settle(front) : try await look(front)
		} catch let none as RPCError where none.kind == .notFound {
			return nil
		}
	}

	/// The act's final view, read after its last settle: its own window, and for a window expect the app's main window,
	/// each settled. Every verdict of the act reads this one view: a set's hold, the expect, and the state it answers. A
	/// look that is not final (a poll's) only says when to read it again. The first read takes the look the last step
	/// settled on, when one did, and an act with no steps settles from its first look.
	func final(_ aim: inout Aim, reuse: View? = nil, from first: View? = nil) async throws -> (own: View?, front: View?) {
		let own: View?
		if let reuse { own = reuse } else { own = try await aimed(&aim, settled: true, from: first) }
		guard aim.waitsForWindow, !aim.closed, aim.window?.window != nil else { return (own, own) }
		return (own, try await frontLook(aim, settled: true))
	}

	/// Whether a set's value is still what it set in the act's final view: a switch's, checkbox's or radio's checked
	/// flag, else the element's value.
	func setHolds(_ ref: String, _ value: String, _ view: View) -> Bool {
		guard let handle = store.handle(ref), let node = view.node(handle) else { return false }
		if ["switch", "checkbox", "radio"].contains(node.role) { return (value == "on") == node.flags.contains(.checked) }
		return node.value == value
	}

	/// The kinds a step's refusal carries; any other failure fails the whole call.
	static let stepKinds: Set<ErrorKind> = [.notFound, .invalid, .timeout, .denied, .limit, .unsupported, .stale, .refused]

	/// How a step's effect is checked once it settled: a readback, or a change in the window (a window that closed is
	/// one). A set's readback is held again on the act's final view (setHolds).
	enum Check {
		case readback(@Sendable () -> Bool)
		case change
	}

	/// One way to do a step: its route, why it can't be taken (nil when it can), and the doing. notAllowed: the route
	/// works here but the call does not allow it (the foreground route without foreground: true).
	struct Attempt {
		let route: Route
		let off: String?
		var notAllowed = false
		let run: () async throws -> Check
	}

	/// Checks a step against the look it runs on, runs it by the first route that can, settles, and checks its effect.
	/// Answers the route, whether the effect showed, and the settled look: nil when the step closed the app's last window.
	func run(_ step: Step, view: View, state: String?, held: View?, foreground: Bool) async throws -> (Route, Bool, View?) {
		let target = view.target
		if case .nav(let nav) = step {
			throw RPCError.unsupported("nav \(nav.rawValue): ui.nav is off here: \(FeatureName.navOff)")
		}
		let (node, element) = try self.element(step.ref, in: view)
		// A step on a disabled control is refused, so its text never goes to whatever has the focus.
		if let ref = step.ref, let node, node.flags.contains(.disabled) {
			throw RPCError(.refused, "\(node.name ?? ref) is disabled: a step on it does nothing")
		}
		if case .type(_, let into?) = step, let node, !node.textInput {
			throw RPCError(.refused, "\(into) is not a text field: nothing was typed")
		}
		if let point = step.point { try await bind(point, view: view, state: state, held: held) }
		mark(step, element: element, target: target)

		let attempts: [Attempt]
		switch step {
		case .nav:
			fatalError("handled above")

		case .press(let ref):
			attempts = [
				semantic(node!.actions.contains(ax.pressAction) ? nil : "\(ref) has no \(ax.pressAction)") {
					try self.ax.perform(self.ax.pressAction, on: element!)
					return .change
				},
			] + pointer(foreground, target) { route in
				try await route.click(at: try self.center(ref, element!, in: target), button: .left, count: 1, in: target)
				return .change
			}

		case .set(let ref, let value):
			let secure = node!.flags.contains(.secure)
			// An item that opens (a Finder file) is refused with the way that works, so a model takes it on the first try.
			let opens = node!.actions.contains(ax.openAction)
			let refused = opens
				? "\(node!.name ?? ref) is a list item that opens: select it and press Return to edit its name, then type"
				: "\(ref)'s value cannot be set: click it and type instead"
			attempts = [
				semantic(node!.settable ? nil : refused) {
					try self.ax.setValue(value, on: element!)
					let ax = self.ax
					return secure ? .readback { false } : .readback { ax.value(element!) == value }
				},
			]

		case .perform(let ref, let action):
			let actions = node!.actions
			attempts = [
				semantic(actions.contains(action) ? nil : "\(ref) has no action \(action): it has \(actions.isEmpty ? "none" : actions.joined(separator: ", "))") {
					try self.ax.perform(action, on: element!)
					return .change
				},
			]

		case .click(let at, let button, let count):
			let button = button ?? .left
			let count = count ?? 1
			var first: [Attempt] = []
			let point: () throws -> Point
			switch at {
			case .ref(let ref):
				let actions = node!.actions
				if button == .left && count == 1 && actions.contains(ax.pressAction) {
					first.append(semantic(nil) {
						try self.ax.perform(self.ax.pressAction, on: element!)
						return .change
					})
				} else if button == .left && count == 1 {
					// No AXPress (a Finder file, a table row): a click on it selects it, so the semantic route selects
					// it and reads the selection back. A point only when Accessibility cannot select it (a canvas).
					first.append(semantic(nil) {
						let selected = try self.ax.select(element!)
						let ax = self.ax
						return .readback { ax.isSelected(selected) }
					})
				} else if button == .right && count == 1 {
					first.append(semantic(actions.contains(ax.menuAction) ? nil : "\(ref) has no \(ax.menuAction)") {
						try self.ax.perform(self.ax.menuAction, on: element!)
						return .change
					})
				}
				point = { try self.center(ref, element!, in: target) }
			case .point(let p):
				point = { target.toScreen(p) }
			}
			attempts = first + pointer(foreground, target) { route in
				try await route.click(at: try point(), button: button, count: count, in: target)
				return .change
			}

		case .type(let text, let into):
			let typed = into == nil ? (ax.focused(target)) : element
			let secure = node?.flags.contains(.secure) == true
			let ax = self.ax
			let readback: Check = {
				guard let typed, !secure, ax.value(typed) != nil else { return .change }
				return .readback { ax.value(typed)?.contains(text) == true }
			}()
			var reason: String?
			if typed == nil {
				reason = "no element has keyboard focus"
			} else if secure {
				reason = "a secure field takes typed keys only"
			} else if into == nil, !ax.takesText(typed!) {
				// A list, a canvas or a web view with the focus takes keys, never an inserted text: an insert there
				// changed nothing, and was taken for the typing.
				reason = "the element with keyboard focus takes no inserted text"
			} else if into == nil, let key = ax.keyWindow(target), key != target.window.id {
				reason = "\(target.app.id)'s keyboard focus is in its window \(key), not this one"
			}
			let insert = semantic(reason) {
				try ax.insertText(text, on: typed!)
				return readback
			}
			let keys = pointer(foreground, target) { route in
				if let into, let element { try await self.focus(into, element, target: target, route: route) }
				try await route.type(text, in: target)
				return readback
			}
			// A document's text takes an edit as one only through the app's text system: TextEdit showed an inserted
			// text and never marked the document edited, so saving kept the old file. Typed keys go first there.
			let document = (node ?? typed.flatMap { view.node($0) })?.keysFirst == true
			attempts = document ? keys + [insert] : [insert] + keys

		case .key(let text):
			let chord = try KeyChord.parse(text)
			let menu = chord.modifiers.contains(.cmd) ? ax.menuItem(for: chord, in: target) : nil
			// A menu item acts on the app's key window: pressed while another of its windows is key, it would close or
			// save that one.
			var off = menu == nil ? "no menu item takes \(chord.text)" : nil
			if off == nil, let key = ax.keyWindow(target), key != target.window.id {
				off = "the menu item for \(chord.text) acts on \(target.app.id)'s key window, \(key), not this one"
			}
			attempts = [
				semantic(off) {
					try self.ax.perform(self.ax.pressAction, on: menu!)
					return .change
				},
			] + pointer(foreground, target, keys: true) { route in
				try await route.key(chord, in: target)
				return .change
			}

		case .scroll(let at, let dx, let dy):
			let point: Point
			switch at {
			case .ref(let ref): point = try center(ref, element!, in: target)
			case .point(let p): point = target.toScreen(p)
			}
			attempts = pointer(foreground, target) { route in
				try await route.scroll(at: point, dx: Double(dx ?? 0), dy: Double(dy ?? 0), in: target)
				return .change
			}

		case .drag(let path, let ms):
			let window = Rect(0, 0, target.window.bounds.w, target.window.bounds.h)
			if let outside = path.first(where: { !window.contains($0) }) {
				throw RPCError.invalid("(\(Int(outside.x)), \(Int(outside.y))) is outside the window, which is \(Int(window.w)) by \(Int(window.h)) points")
			}
			// Every point of the path is held to the state, as much as the first.
			for point in path.dropFirst() { try await bind(point, view: view, state: state, held: held) }
			attempts = pointer(foreground, target) { route in
				try await route.drag(path.map(target.toScreen), ms: ms ?? 300, in: target)
				return .change
			}
		}
		return try await ladder(step, view: view, attempts)
	}

	func semantic(_ off: String?, _ run: @escaping () async throws -> Check) -> Attempt {
		if case .off(let reason) = ax.feature { return Attempt(route: .semantic, off: "ui.tree is off here: \(reason)", run: run) }
		return Attempt(route: .semantic, off: off, run: run)
	}

	/// The background route, then the foreground one, for a step done by posting input. For a key chord, when the call
	/// allows the foreground and the target's app is already in front, the foreground route goes first: the user's
	/// focus is there already, and it raises the target's window and makes it key, which an app in front with several
	/// windows (Finder, its desktop among them) needs for keys to reach that window. Pointer steps keep background
	/// first: CI's canvas click did not land by the foreground route with the fixture in front.
	func pointer(_ allowed: Bool, _ target: ResolvedTarget, keys: Bool = false, _ body: @escaping (any InputRoute) async throws -> Check) -> [Attempt] {
		var background: String?
		if case .off(let reason) = platform.backgroundFeature { background = "ui.background is off here: \(reason)" }
		var foreground: String?
		var notAllowed = false
		if case .off(let reason) = platform.foregroundFeature {
			foreground = "ui.foreground is off here: \(reason)"
		} else if !allowed {
			foreground = "it moves the user's pointer and focus, and this call does not allow it: pass foreground: true"
			notAllowed = true
		}
		let bg = platform.background
		let fg = platform.foreground
		let routes = [
			Attempt(route: .background, off: background) { try await body(bg) },
			Attempt(route: .foreground, off: foreground, notAllowed: notAllowed) { try await body(fg) },
		]
		let inFront = keys && allowed && foreground == nil && platform.workspace.frontmost == target.pid
		return inFront ? routes.reversed() : routes
	}

	/// Takes the first route that can do the step; settles; checks. Only a route that reports it sent nothing
	/// (RouteUnavailable: the element takes no such action, the window is covered) lets the next route try. A route
	/// that sent the step owns it, whether or not its effect showed by the settle: an effect can come late (a Save that
	/// writes 300 ms on), so the act's expect waits for it up to its timeout, and no other route sends the step again,
	/// which would press a button or submit a form twice. When the one route left is one the call does not allow, the
	/// step is refused denied (the call can allow it); when no route reaches it here, unsupported.
	func ladder(_ step: Step, view: View, _ attempts: [Attempt]) async throws -> (Route, Bool, View?) {
		var reasons: [String] = []
		var denied = false
		for attempt in attempts {
			if let off = attempt.off {
				reasons.append("\(attempt.route.rawValue): \(off)")
				denied = denied || attempt.notAllowed
				continue
			}
			// The foreground route takes the person's own pointer and keys: a person at them since the act began keeps
			// them, and nothing is sent.
			if attempt.route == .foreground { try takeOver?.check(platform) }
			let check: Check
			do {
				check = try await attempt.run()
			} catch let unavailable as RouteUnavailable {
				reasons.append("\(attempt.route.rawValue): \(unavailable.reason)")
				continue
			}
			let after = try await settleAfterStep(view.target)
			if attempt.route == .foreground {
				// Read once the step settled: the pointer the route moved is where it reads by then.
				takeOverArmed = true
				takeOver?.pointer = platform.capture.cursor()
			}
			switch check {
			case .readback(let holds):
				return (attempt.route, holds(), after)
			case .change:
				return (attempt.route, after.map { view.fingerprint != $0.fingerprint } ?? true, after)
			}
		}
		let words = "no route could \(step.verb) here. " + reasons.joined(separator: "; ")
		throw denied ? RPCError.denied(words) : RPCError.unsupported(words)
	}

	// MARK: elements and points

	/// The element a step's ref names, and its node with its actions and settable read now, if the element is still in
	/// the window. A look capped short of it asks the tree whether it still exists.
	func element(_ ref: String?, in view: View) throws -> (RawNode?, ElementHandle?) {
		guard let ref else { return (nil, nil) }
		let handle = store.handle(ref)!
		guard var node = view.node(handle) ?? (view.truncated && ax.exists(handle) ? store.lastSeen(ref) : nil) else {
			throw RPCError.stale("\(ref) is gone: its element is no longer in the window. Observe again for fresh refs")
		}
		(node.actions, node.settable) = ax.details(handle)
		return (node, handle)
	}

	/// Marks the step's place for the live view (Marks): its element, else its point, else (a key or text to the window's
	/// focus) where the last step was.
	func mark(_ step: Step, element: ElementHandle?, target: ResolvedTarget) {
		let frame = element.flatMap { ax.frame($0) }.flatMap { $0.area > 0 ? $0 : nil }
		let marks = platform.marks
		let kind: Marks.Kind
		switch step {
		case .press, .click, .perform: kind = .press
		case .type, .set: kind = frame == nil ? .point : .type
		case .key, .scroll, .drag, .nav: kind = .point
		}
		if let frame {
			stepMark = marks.mark(kind, at: frame.center, box: kind == .type ? frame : nil, now: clock.now())
		} else if let point = step.point {
			stepMark = marks.mark(kind, at: target.toScreen(point), now: clock.now())
		} else if let last = marks.lastPoint {
			stepMark = marks.mark(.point, at: last, now: clock.now())
		} else {
			stepMark = nil
		}
	}

	/// The middle of an element on screen, scrolled into its window's view when it is outside it.
	func center(_ ref: String, _ element: ElementHandle, in target: ResolvedTarget) throws -> Point {
		guard var frame = ax.frame(element), frame.area > 0 else {
			throw RouteUnavailable("\(ref) has no frame on screen to point at")
		}
		if !target.window.bounds.contains(frame.center) {
			try? ax.scrollToVisible(element)
			if let moved = ax.frame(element) {
				frame = moved
				// The step's mark was read before the scroll: it follows the element to where the pointer goes.
				if let stepMark { platform.marks.move(stepMark, to: moved.center, box: moved) }
			}
		}
		guard target.window.bounds.contains(frame.center) else {
			throw RouteUnavailable("\(ref) is outside its window's visible area: scroll to it first")
		}
		return frame.center
	}

	/// Gives an element keyboard focus before typing into it: through the tree, else by clicking it on the same route.
	func focus(_ ref: String, _ element: ElementHandle, target: ResolvedTarget, route: any InputRoute) async throws {
		if (try? ax.focus(element)) != nil, try await tookFocus(element, target) { return }
		try await route.click(at: try center(ref, element, in: target), button: .left, count: 1, in: target)
		guard try await tookFocus(element, target) else {
			throw RPCError(.refused, "\(ref) did not take the keyboard focus, so nothing was typed: a field's text never goes to whatever has the focus")
		}
	}

	/// The element has keyboard focus, as it may take a moment to: a request an app ignores or delays is not focus.
	func tookFocus(_ element: ElementHandle, _ target: ResolvedTarget) async throws -> Bool {
		for look in 0..<4 {
			if ax.focused(target) == element { return true }
			if look < 3 { try await sleep(40) }
		}
		return false
	}

	/// A point is good while it still means what it meant in its state: the same window at the same size, and the same
	/// element under it, looking the same. The window may have moved: points are the window's.
	func bind(_ point: Point, view: View, state: String?, held: View?) async throws {
		let (x, y) = (Int(point.x), Int(point.y))
		guard let held else {
			throw RPCError.stale("state \(state ?? "") is no longer held: observe again, and read the point from the new state")
		}
		guard held.target.window.id == view.target.window.id else {
			throw RPCError.stale("the window of state \(state!) is not the act's window: observe again")
		}
		let (then, now) = (held.target.window.bounds, view.target.window.bounds)
		guard then.w == now.w, then.h == now.h else {
			throw RPCError.stale("the window changed size since state \(state!), so (\(x), \(y)) may not land on what it showed: observe again")
		}
		guard Rect(0, 0, now.w, now.h).contains(point) else {
			throw RPCError.invalid("(\(x), \(y)) is outside the window, which is \(Int(now.w)) by \(Int(now.h)) points")
		}
		let before = held.under(point)
		let after = view.under(point)
		if before?.handle != after?.handle || (before.map(held.looks) != after.map(view.looks)) {
			throw RPCError.stale("what is at (\(x), \(y)) changed since state \(state!): observe again")
		}
		// With no element under the point (always so with ui.tree off), only the window's image can say it still shows
		// what the state did.
		if before == nil, await held.frame != framed(view).frame {
			throw RPCError.stale("the window shows something else than at state \(state!), so (\(x), \(y)) may not land on what it showed: observe again")
		}
	}

	// MARK: settle and expect

	/// The settled look after a step: of the step's window, or, when the step closed it (super+w on its last tab), of
	/// the app's next main window, which the rest of the act follows, as a nav step follows the front window. nil when
	/// the app has no window left: the act then answers window "closed".
	func settleAfterStep(_ target: ResolvedTarget) async throws -> View? {
		do {
			return try await settle(target.asTarget)
		} catch let error as RPCError where error.kind == .notFound {
			return try await follow(target.app.id, settled: true)
		}
	}

	/// The app's main window once the act's window closed, settled or one look; nil when the app is running with no
	/// window left. An app that quit has nothing to follow, and is not_found in words.
	func follow(_ app: String, settled: Bool) async throws -> View? {
		let next = Target(app: app, window: nil)
		do {
			return settled ? try await settle(next) : try await look(next)
		} catch let none as RPCError where none.kind == .notFound {
			guard platform.workspace.running(app) else {
				throw RPCError.notFound("\(app) is no longer running: the act's window closed and the app quit (\(none.message))")
			}
			return nil
		}
	}

	/// Looks until two looks quietMs apart are the same, or settleMaxMs passed: the settled look. Apart is the time
	/// between the end of one look and the start of the next, however long a look took: an app answers a look on the
	/// thread it draws on, so the quiet is time it is left alone to draw. A settle starts from `first` when the act
	/// already took that look and nothing ran since. An app that tells its changes settles on them instead (settleTold).
	func settle(_ target: Target?, from first: View? = nil) async throws -> View {
		let until = clock.now() + timing.settleMaxMs
		let pid: Int32? = if let first { first.at == nil ? nil : first.target.pid } else { target?.app.flatMap { watched[$0] } }
		if let pid, timing.quietMs > 0 { return try await settleTold(target, from: first, pid: pid, until: until) }
		var last: View
		if let first { last = first } else { last = try await look(target) }
		while timing.quietMs > 0 && clock.now() < until {
			try await sleep(min(timing.quietMs, max(0, until - clock.now())))
			let next = try await look(target)
			let quiet = next.fingerprint == last.fingerprint
			last = next
			if quiet { break }
		}
		return last
	}

	/// The settle at an app that tells its changes (Platform.changes): it waits until the app told none for quietMs,
	/// reads the window once, and reads it again only when the app told one after that read began. A read the same as
	/// the one before settles too, as two looks do: an app may tell changes a person never sees (System Settings remakes
	/// its sidebar's rows out of view each time its tree is read). The quiet counts from the read it starts from, else
	/// from now, the step having just been sent. settleMaxMs bounds it as it does two looks.
	func settleTold(_ target: Target?, from first: View?, pid: Int32, until: Double) async throws -> View {
		var (pid, last, since) = (pid, first, first?.at ?? clock.now())
		while true {
			try await quiet(pid, since: since, until: until)
			if let last, let at = last.at, !told(pid, since: at) || clock.now() >= until { return last }
			let next = try await look(target)
			guard let at = next.at else { return next }
			if !told(next.target.pid, since: at) || next.fingerprint == last?.fingerprint || clock.now() >= until { return next }
			(pid, last, since) = (next.target.pid, next, at)
		}
	}

	/// An expect's wait at an app that tells its changes: until the app told one after the read `view` began, `until`, or
	/// untoldMs with none told. False, at once, for a view of an app that tells none, or no view (a window expect before
	/// the window): then the expect polls with looks.
	func awaitTold(_ view: View?, until: Double) async throws -> Bool {
		guard let view, let at = view.at else { return false }
		let enough = min(until, clock.now() + timing.untoldMs)
		while !told(view.target.pid, since: at), clock.now() < enough {
			try await sleep(min(timing.expectPollMs, enough - clock.now()))
		}
		return true
	}

	/// Waits until the app told no change for quietMs, counted from `since` at the earliest, or until `until`.
	func quiet(_ pid: Int32, since: Double, until: Double) async throws {
		while true {
			let last = max(since, platform.changes?.lastChange(pid) ?? since)
			let left = min(last + timing.quietMs, until) - clock.now()
			guard left > 0 else { return }
			try await sleep(left)
		}
	}

	/// The expect holds in this look. text: some node's name, value or desc holds it (never a secure field's value). ref:
	/// the element is there. Both: that element's name, value or desc holds the text. window: the window's title holds
	/// its title and its role is its role (absent is "window"). gone turns each around. No look (no window) shows
	/// nothing, so only a gone expect holds there.
	func holds(_ expect: Expect, _ view: View?) -> Bool {
		func has(_ node: RawNode, _ text: String) -> Bool {
			node.name?.contains(text) == true || node.desc?.contains(text) == true
				|| (!node.flags.contains(.secure) && node.value?.contains(text) == true)
		}
		let seen = view.map { shows(expect, $0, has) } ?? false
		return expect.gone == true ? !seen : seen
	}

	/// What an expect looks for is in this look, gone or not.
	func shows(_ expect: Expect, _ view: View, _ has: (RawNode, String) -> Bool) -> Bool {
		if let wanted = expect.window {
			let shown = view.target.window
			return (wanted.title.map { shown.title?.contains($0) == true } ?? true) && (wanted.role.map { (shown.role ?? "window") == $0 } ?? true)
		}
		if let ref = expect.ref {
			let handle = store.handle(ref)!
			if let node = view.node(handle) { return expect.text.map { has(node, $0) } ?? true }
			return expect.text == nil && view.truncated && ax.exists(handle)
		}
		return view.nodes.contains { has($0, expect.text!) }
	}

	func sleep(_ ms: Double) async throws {
		do {
			try await clock.sleep(ms: ms)
		} catch {
			throw RPCError.aborted
		}
	}
}

extension ResolvedTarget {
	/// The target that finds this app and window again.
	var asTarget: Target { Target(app: app.id, window: window.id) }
}

extension Rect {
	public func intersects(_ other: Rect) -> Bool {
		x < other.x + other.w && other.x < x + w && y < other.y + other.h && other.y < y + h
	}
}
