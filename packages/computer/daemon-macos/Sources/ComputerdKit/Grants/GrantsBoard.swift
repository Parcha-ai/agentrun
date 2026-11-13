/// The grants window's state, apart from AppKit: the System Settings panes that hold Computerd's grants, which grants are
/// in, which pane was opened last, and whether the window's job is done. The window reads the grants on a timer and hands
/// them to observe; what comes back is what it does next.
public struct GrantsBoard: Sendable, Equatable {
	/// One System Settings pane and the grants switched on in its list. Dragging the app into the list gives them all.
	public struct Pane: Sendable, Equatable {
		/// What System Settings calls the pane.
		public let name: String
		/// The pane's anchor in Privacy & Security, such as Privacy_Accessibility.
		public let anchor: String
		/// The grants the pane's list gives, by name, in the window's order.
		public let grants: [String]

		public init(name: String, anchor: String, grants: [String]) {
			self.name = name
			self.anchor = anchor
			self.grants = grants
		}

		/// The URL that opens the pane.
		public var url: String { "x-apple.systempreferences:com.apple.preference.security?\(anchor)" }
	}

	/// What the window does after a look at the grants.
	public enum Step: Sendable, Equatable {
		/// Opens this pane in System Settings, beside the window.
		case open(Pane)
		/// Every grant is in: the window says so and closes.
		case done
	}

	public let panes: [Pane]
	public private(set) var granted: Set<String> = []
	/// The anchor of the pane opened last, by the board or by a click on its tile.
	public private(set) var opened: String?
	/// Every grant was in at some look. It stays set: the window has closed by then.
	public private(set) var finished = false

	/// Panes in the window's order. A grant belongs to one pane.
	public init(panes: [Pane]) {
		self.panes = panes
	}

	public func isGranted(_ grant: String) -> Bool { granted.contains(grant) }

	/// Every grant in the pane's list is in.
	public func isGranted(_ pane: Pane) -> Bool { pane.grants.allSatisfy(granted.contains) }

	public var allGranted: Bool { panes.allSatisfy(isGranted) }

	/// The first pane with a grant still missing.
	public var waiting: Pane? { panes.first { !isGranted($0) } }

	/// Takes the grants as they are now. The first pane still waiting opens when no pane was opened yet, or when the one
	/// opened last has just got all its grants; a person still in a waiting pane is left there. The first look with every
	/// grant in answers done, once.
	public mutating func observe(_ now: Set<String>) -> [Step] {
		granted = now
		if finished { return [] }
		if allGranted {
			finished = true
			return [.done]
		}
		guard let next = waiting else { return [] }
		if let opened, let pane = panes.first(where: { $0.anchor == opened }), !isGranted(pane) { return [] }
		opened = next.anchor
		return [.open(next)]
	}

	/// A click on a pane's tile: that pane is the one open now. Nil for an anchor the board does not hold.
	public mutating func choose(_ anchor: String) -> Pane? {
		guard let pane = panes.first(where: { $0.anchor == anchor }) else { return nil }
		opened = anchor
		return pane
	}
}
