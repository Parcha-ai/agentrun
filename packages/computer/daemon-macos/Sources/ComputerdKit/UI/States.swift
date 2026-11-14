import Foundation

/// One look at a window: its app and window, its tree in walk order, and a hash of how it looks.
struct View: Sendable {
	let target: ResolvedTarget
	let nodes: [RawNode]
	let truncated: Bool
	/// The window image's hash: always read when the tree has no nodes (ui.tree off), and for a look kept as a state;
	/// nil on the looks a settle and an expect take, where the tree says what changed.
	let frame: Int?
	/// When the read began, on the platform's Clock, for an app whose changes the platform tells (Platform.changes): a
	/// change told after it may be missing from this look. nil for an app that tells none.
	let at: Double?

	func with(frame: Int?) -> View { View(target: target, nodes: nodes, truncated: truncated, frame: frame, at: at) }

	/// The node for an element, if this look has it.
	func node(_ handle: ElementHandle) -> RawNode? {
		nodes.first { $0.handle == handle }
	}

	/// The deepest element under a window point: the last in walk order whose bounds hold it.
	func under(_ point: Point) -> RawNode? {
		let screen = target.toScreen(point)
		return nodes.last { $0.frame?.contains(screen) == true }
	}

	/// A node's bounds in the window's points, each edge that reaches past the window's held to it (wire.md, ui.observe):
	/// a row half scrolled out of a list is the part a person sees, and one wholly out is a line on the edge it left by.
	/// So a list's content, taller than its window, keeps its bounds while the app guesses its height anew on each read
	/// (System Settings' sidebar).
	func bounds(_ node: RawNode) -> Rect {
		guard let frame = node.frame else { return Rect(0, 0, 0, 0) }
		let (w, h) = (target.window.bounds.w, target.window.bounds.h)
		let r = frame.offset(-target.window.bounds.x, -target.window.bounds.y)
		func held(_ v: Double, _ most: Double) -> Double { min(most, max(0, v)) }
		let (left, top) = (held(r.x, w), held(r.y, h))
		return Rect(left, top, held(r.x + r.w, w) - left, held(r.y + r.h, h) - top)
	}

	/// What a person sees of a node: its role, words, place and flags. A secure field's value is never in it.
	func looks(_ node: RawNode) -> String {
		let b = bounds(node)
		let value = node.flags.contains(.secure) ? "" : node.value ?? ""
		return [node.role, node.name ?? "", value, node.desc ?? "", "\(b.x),\(b.y),\(b.w),\(b.h)", node.flags.sorted().map(\.rawValue).joined(separator: ",")].joined(separator: "\u{1f}")
	}

	/// What a person would see of the whole window: its id and size and every node on it; with no nodes (ui.tree off),
	/// the image's hash. Not the image when there is a tree: a blinking caret or a spinner redraws the window every half
	/// second, which held every settle to maxSettleMs and counted as a step's effect. Not a node wholly outside the
	/// window: System Settings rebuilds its sidebar rows scrolled out of view each time its tree is read, and Finder's
	/// status bar below the window counts the free disk space, which held every settle there to maxSettleMs too. Nor
	/// which element a node is: a person sees none of that, and System Settings makes its sidebar's row at the window's
	/// edge anew on every read, the same words in the same place.
	var fingerprint: Int {
		var h = Hasher()
		h.combine(target.window.id)
		h.combine(target.window.bounds.w)
		h.combine(target.window.bounds.h)
		for node in nodes where onWindow(node) { h.combine(looks(node)) }
		if nodes.isEmpty { h.combine(frame) }
		return h.finalize()
	}

	/// The node's frame reaches into the window; a node with no frame counts as on it.
	func onWindow(_ node: RawNode) -> Bool {
		node.frame.map { $0.intersects(target.window.bounds) } ?? true
	}
}

/// The refs and states of one connection. A ref names one element for as long as the element exists, across states;
/// a state is one look, and the points read from it belong to it.
struct StateStore: Sendable {
	/// How many states a connection keeps for since and for points; an older one is refused as stale.
	static let heldStates = 32
	/// Refs no held state names are let go past this many.
	static let heldRefs = 20_000

	private var states: [(id: String, view: View)] = []
	private var refs: [ElementHandle: String] = [:]
	private var handles: [String: ElementHandle] = [:]
	/// Each ref's element as last seen, for a step on an element past a later walk's cap.
	private var nodes: [String: RawNode] = [:]
	private var nextRef = 1
	private var nextState = 1

	/// The ref for an element: the one it already has, or a new one.
	mutating func ref(for node: RawNode) -> String {
		if let known = refs[node.handle] {
			nodes[known] = node
			return known
		}
		let ref = "@e\(nextRef)"
		nextRef += 1
		refs[node.handle] = ref
		handles[ref] = node.handle
		nodes[ref] = node
		return ref
	}

	/// The ref an element has, without giving it one.
	func known(_ handle: ElementHandle) -> String? { refs[handle] }

	func handle(_ ref: String) -> ElementHandle? { handles[ref] }

	func lastSeen(_ ref: String) -> RawNode? { nodes[ref] }

	func view(_ id: String) -> View? {
		states.last { $0.id == id }?.view
	}

	/// Holds a look as a new state, and lets the oldest go.
	mutating func add(_ view: View) -> String {
		let id = "s\(nextState)"
		nextState += 1
		states.append((id, view))
		if states.count > Self.heldStates { states.removeFirst(states.count - Self.heldStates) }
		if handles.count > Self.heldRefs { prune() }
		return id
	}

	private mutating func prune() {
		var live = Set<ElementHandle>()
		for state in states { for node in state.view.nodes { live.insert(node.handle) } }
		for (ref, handle) in handles where !live.contains(handle) {
			handles[ref] = nil
			refs[handle] = nil
			nodes[ref] = nil
		}
	}
}
