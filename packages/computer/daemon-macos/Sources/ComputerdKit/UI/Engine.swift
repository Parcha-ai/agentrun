import Foundation

/// A route could not do this step here, for a reason that lets the next route try: the element took no press, the
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

	public init() {}
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
	/// server's list, with no nodes; with ui.image off as well there is nothing to look with.
	func look(_ target: Target?) async throws -> View {
		if let app = target?.app { try policy.check(app) }
		let resolved: ResolvedTarget
		let snapshot: Snapshot
		switch (ax.feature, platform.capture.feature) {
		case (.on, _):
			resolved = try ax.resolve(target)
			try policy.check(resolved.app.id)
			snapshot = try ax.snapshot(resolved, maxNodes: Limits.maxUiNodes)
		case (.off, .on):
			resolved = try platform.capture.resolve(target)
			try policy.check(resolved.app.id)
			snapshot = Snapshot(nodes: [], truncated: false)
		case (.off(let tree), .off(let image)):
			throw RPCError.denied("ui.tree is off here: \(tree); and ui.image is off: \(image). Without either, Computerd cannot see a window")
		}
		let frame = platform.capture.feature.isOn ? await platform.capture.windowHash(resolved) : nil
		return View(target: resolved, nodes: snapshot.nodes, truncated: snapshot.truncated, frame: frame)
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
		let view = try await look(params.target)
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
			guard e.text != nil || e.ref != nil else { throw RPCError.invalid("ui.act: expect names neither text nor ref: it needs at least one") }
			if case .off(let reason) = ax.feature {
				throw RPCError.unsupported("ui.act: an expect reads the window's elements, and ui.tree is off here: \(reason)")
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

		let first = try await look(target)
		// Every later look is of the window the first one found, even if another app comes to the front.
		let window = first.target.asTarget
		var view = first
		var results: [StepResult] = []
		var refused = false
		for step in params.steps {
			try Task.checkCancellation()
			do {
				let (route, verified, after) = try await run(step, view: view, state: params.state, held: held, foreground: foreground)
				results.append(.ran(route: route, verified: verified))
				view = after
			} catch let error as RPCError where Self.stepKinds.contains(error.kind) {
				results.append(.error(StepError(kind: error.kind, message: error.message)))
				refused = true
				break
			}
		}
		if refused || params.steps.isEmpty { view = try await settle(window) }
		var outcome: ExpectOutcome?
		if let expect = params.expect, !refused {
			let until = clock.now() + Double(expect.timeoutMs ?? Limits.defaultExpectMs)
			while true {
				if holds(expect, view) {
					outcome = .met
					break
				}
				if clock.now() >= until {
					outcome = .unmet
					break
				}
				try await sleep(min(timing.expectPollMs, max(1, until - clock.now())))
				view = try await look(window)
			}
		}
		let state = store.add(view)
		return UiActResult(steps: results, state: state, changed: first.fingerprint != view.fingerprint, expect: outcome)
	}

	/// The kinds a step's refusal carries; any other failure fails the whole call.
	static let stepKinds: Set<ErrorKind> = [.notFound, .invalid, .timeout, .denied, .limit, .unsupported, .stale]

	/// How a step's effect is checked once it settled: a readback, or a change in the window.
	enum Check {
		case readback(@Sendable () -> Bool)
		case change
	}

	/// One way to do a step: its route, why it can't be taken (nil when it can), and the doing.
	struct Attempt {
		let route: Route
		let off: String?
		let run: () async throws -> Check
	}

	/// Checks a step against the look it runs on, runs it by the first route that can, settles, and checks its effect.
	/// Answers the route, whether the effect showed, and the settled look.
	func run(_ step: Step, view: View, state: String?, held: View?, foreground: Bool) async throws -> (Route, Bool, View) {
		let target = view.target
		if case .nav(let nav) = step {
			if case .off(let reason) = platform.navFeature { throw RPCError.unsupported("nav \(nav.rawValue): ui.nav is off here: \(reason)") }
			throw RPCError.unsupported("nav \(nav.rawValue): no route takes it here")
		}
		let (node, element) = try self.element(step.ref, in: view)
		if let point = step.point { try bind(point, view: view, state: state, held: held) }

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
			] + pointer(foreground) { route in
				try await route.click(at: try self.center(ref, element!, in: target), button: .left, count: 1, in: target)
				return .change
			}

		case .set(let ref, let value):
			let secure = node!.flags.contains(.secure)
			attempts = [
				semantic(node!.settable ? nil : "\(ref)'s value cannot be set: click it and type instead") {
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
				if button == .left && count == 1 {
					first.append(semantic(actions.contains(ax.pressAction) ? nil : "\(ref) has no \(ax.pressAction)") {
						try self.ax.perform(self.ax.pressAction, on: element!)
						return .change
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
			attempts = first + pointer(foreground) { route in
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
			} else if let node, !node.textInput {
				reason = "\(into!) does not take text"
			}
			attempts = [
				semantic(reason) {
					try ax.insertText(text, on: typed!)
					return readback
				},
			] + pointer(foreground) { route in
				if let into, let element { try await self.focus(into, element, target: target, route: route) }
				try await route.type(text, in: target)
				return readback
			}

		case .key(let text):
			let chord = try KeyChord.parse(text)
			let menu = chord.modifiers.contains(.cmd) ? ax.menuItem(for: chord, in: target) : nil
			attempts = [
				semantic(menu == nil ? "no menu item takes \(chord.text)" : nil) {
					try self.ax.perform(self.ax.pressAction, on: menu!)
					return .change
				},
			] + pointer(foreground) { route in
				try await route.key(chord, in: target)
				return .change
			}

		case .scroll(let at, let dx, let dy):
			let point: Point
			switch at {
			case .ref(let ref): point = try center(ref, element!, in: target)
			case .point(let p): point = target.toScreen(p)
			}
			attempts = pointer(foreground) { route in
				try await route.scroll(at: point, dx: Double(dx ?? 0), dy: Double(dy ?? 0), in: target)
				return .change
			}

		case .drag(let path, let ms):
			let window = Rect(0, 0, target.window.bounds.w, target.window.bounds.h)
			if let outside = path.first(where: { !window.contains($0) }) {
				throw RPCError.invalid("(\(Int(outside.x)), \(Int(outside.y))) is outside the window, which is \(Int(window.w)) by \(Int(window.h)) points")
			}
			attempts = pointer(foreground) { route in
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

	/// The background route, then the foreground one, for a step done by posting input.
	func pointer(_ allowed: Bool, _ body: @escaping (any InputRoute) async throws -> Check) -> [Attempt] {
		var background: String?
		if case .off(let reason) = platform.backgroundFeature { background = "ui.background is off here: \(reason)" }
		var foreground: String?
		if case .off(let reason) = platform.foregroundFeature {
			foreground = "ui.foreground is off here: \(reason)"
		} else if !allowed {
			foreground = "the call does not allow it (foreground: true), and it moves the user's pointer and focus"
		}
		let bg = platform.background
		let fg = platform.foreground
		return [
			Attempt(route: .background, off: background) { try await body(bg) },
			Attempt(route: .foreground, off: foreground) { try await body(fg) },
		]
	}

	/// Takes the first route that can do the step; settles; checks. A route that turns out unable lets the next try.
	func ladder(_ step: Step, view: View, _ attempts: [Attempt]) async throws -> (Route, Bool, View) {
		var reasons: [String] = []
		for attempt in attempts {
			if let off = attempt.off {
				reasons.append("\(attempt.route.rawValue): \(off)")
				continue
			}
			let check: Check
			do {
				check = try await attempt.run()
			} catch let unavailable as RouteUnavailable {
				reasons.append("\(attempt.route.rawValue): \(unavailable.reason)")
				continue
			}
			let after = try await settle(view.target.asTarget)
			switch check {
			case .readback(let holds): return (attempt.route, holds(), after)
			case .change: return (attempt.route, view.fingerprint != after.fingerprint, after)
			}
		}
		throw RPCError.unsupported("no route could \(step.verb) here. " + reasons.joined(separator: "; "))
	}

	// MARK: elements and points

	/// The element a step's ref names, and its node, if the element is still in the window. A look capped short of it
	/// asks the tree whether it still exists.
	func element(_ ref: String?, in view: View) throws -> (RawNode?, ElementHandle?) {
		guard let ref else { return (nil, nil) }
		let handle = store.handle(ref)!
		if let seen = view.node(handle) { return (seen, handle) }
		if view.truncated, ax.exists(handle), let seen = store.lastSeen(ref) { return (seen, handle) }
		throw RPCError.stale("\(ref) is gone: its element is no longer in the window. Observe again for fresh refs")
	}

	/// The middle of an element on screen, scrolled into its window's view when it is outside it.
	func center(_ ref: String, _ element: ElementHandle, in target: ResolvedTarget) throws -> Point {
		guard var frame = ax.frame(element), frame.area > 0 else {
			throw RouteUnavailable("\(ref) has no frame on screen to point at")
		}
		if !target.window.bounds.contains(frame.center) {
			try? ax.scrollToVisible(element)
			if let moved = ax.frame(element) { frame = moved }
		}
		guard target.window.bounds.contains(frame.center) else {
			throw RouteUnavailable("\(ref) is outside its window's visible area: scroll to it first")
		}
		return frame.center
	}

	/// Gives an element keyboard focus before typing into it: through the tree, else by clicking it on the same route.
	func focus(_ ref: String, _ element: ElementHandle, target: ResolvedTarget, route: any InputRoute) async throws {
		if (try? ax.focus(element)) != nil { return }
		try await route.click(at: try center(ref, element, in: target), button: .left, count: 1, in: target)
	}

	/// A point is good while it still means what it meant in its state: the same window at the same size, and the same
	/// element under it, looking the same. The window may have moved: points are the window's.
	func bind(_ point: Point, view: View, state: String?, held: View?) throws {
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
	}

	// MARK: settle and expect

	/// Looks until two looks quietMs apart are the same, or settleMaxMs passed: the settled look.
	func settle(_ target: Target?) async throws -> View {
		let until = clock.now() + timing.settleMaxMs
		var last = try await look(target)
		while timing.quietMs > 0 && clock.now() < until {
			try await sleep(min(timing.quietMs, max(0, until - clock.now())))
			let next = try await look(target)
			let quiet = next.fingerprint == last.fingerprint
			last = next
			if quiet { break }
		}
		return last
	}

	/// The expect holds in this look. text: some node's name, value or desc holds it (never a secure field's value). ref:
	/// the element is there. Both: that element's name, value or desc holds the text. gone turns each around.
	func holds(_ expect: Expect, _ view: View) -> Bool {
		func has(_ node: RawNode, _ text: String) -> Bool {
			node.name?.contains(text) == true || node.desc?.contains(text) == true
				|| (!node.flags.contains(.secure) && node.value?.contains(text) == true)
		}
		let seen: Bool
		if let ref = expect.ref {
			let handle = store.handle(ref)!
			if let node = view.node(handle) {
				seen = expect.text.map { has(node, $0) } ?? true
			} else {
				seen = expect.text == nil && view.truncated && ax.exists(handle)
			}
		} else {
			seen = view.nodes.contains { has($0, expect.text!) }
		}
		return expect.gone == true ? !seen : seen
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
	func intersects(_ other: Rect) -> Bool {
		x < other.x + other.w && other.x < x + w && y < other.y + other.h && other.y < y + h
	}
}
