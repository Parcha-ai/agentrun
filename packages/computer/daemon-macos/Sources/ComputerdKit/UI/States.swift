import Foundation

/// One look at a window: its app and window, its tree in walk order, and a hash of how it looks.
struct View: Sendable {
	let target: ResolvedTarget
	let nodes: [RawNode]
	let truncated: Bool
	/// The window image's hash: always read when the tree has no nodes (ui.tree off), and for a look kept as a state;
	/// nil on the looks a settle and an expect take, where the tree says what changed.
	let frame: Int?

	func with(frame: Int?) -> View { View(target: target, nodes: nodes, truncated: truncated, frame: frame) }

	/// The node for an element, if this look has it.
	func node(_ handle: ElementHandle) -> RawNode? {
		nodes.first { $0.handle == handle }
	}

	/// The deepest element under a window point: the last in walk order whose bounds hold it.
	func under(_ point: Point) -> RawNode? {
		let screen = target.toScreen(point)
		return nodes.last { $0.frame?.contains(screen) == true }
	}

	/// A node's bounds in the window's points.
	func bounds(_ node: RawNode) -> Rect {
		node.frame.map { $0.offset(-target.window.bounds.x, -target.window.bounds.y) } ?? Rect(0, 0, 0, 0)
	}

	/// What a person sees of a node: its role, words, place and flags. A secure field's value is never in it.
	func looks(_ node: RawNode) -> String {
		let b = bounds(node)
		let value = node.flags.contains(.secure) ? "" : node.value ?? ""
		return [node.role, node.name ?? "", value, node.desc ?? "", "\(b.x),\(b.y),\(b.w),\(b.h)", node.flags.sorted().map(\.rawValue).joined(separator: ",")].joined(separator: "\u{1f}")
	}

	/// What a person would see of the whole window: its id and size and every node; with no nodes (ui.tree off), the
	/// image's hash. Not the image when there is a tree: a blinking caret or a spinner redraws the window every half
	/// second, which held every settle to maxSettleMs and counted as a step's effect.
	var fingerprint: Int {
		var h = Hasher()
		h.combine(target.window.id)
		h.combine(target.window.bounds.w)
		h.combine(target.window.bounds.h)
		for node in nodes {
			h.combine(node.handle)
			h.combine(looks(node))
		}
		if nodes.isEmpty { h.combine(frame) }
		return h.finalize()
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
