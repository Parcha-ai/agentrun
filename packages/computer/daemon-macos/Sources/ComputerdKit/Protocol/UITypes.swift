import Foundation

// The ui group (protocol 0.2): eyes and hands with meaning. ui.observe looks at one app's window and names its
// elements by ref; ui.act runs steps on them, settles, and says what happened. The shapes are protocol.ts's; a test
// holds them to spec/computer/schema/methods.schema.json.

/// Which app, and which of its windows. An app is a bundle id; a window is its id as ui.observe gave it. Left out, the
/// app is the one in front and the window is its main window.
public struct Target: Sendable, Codable, Equatable, Hashable {
	public var app: String?
	public var window: String?

	public init(app: String? = nil, window: String? = nil) {
		self.app = app
		self.window = window
	}
}

/// Whether ui.observe sends the window's image, and how big: `true`, or `{maxEdge}` in image pixels.
public enum ImageOption: Sendable, Codable, Equatable {
	case none
	case image(maxEdge: Int?)

	public init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if let flag = try? c.decode(Bool.self) {
			self = flag ? .image(maxEdge: nil) : .none
			return
		}
		guard let sized = try? c.decode(Sized.self) else { throw decoder.corrupted("image is true, false or {maxEdge}") }
		self = .image(maxEdge: sized.maxEdge)
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.singleValueContainer()
		switch self {
		case .none: try c.encode(false)
		case .image(nil): try c.encode(true)
		case .image(let edge?): try c.encode(Sized(maxEdge: edge))
		}
	}

	struct Sized: Codable { var maxEdge: Int }
}

public struct UiObserveParams: Sendable, Codable, Equatable {
	public var target: Target?
	/// Every node, not only the ones that can be acted on or have a name, and their parents.
	public var full: Bool?
	public var image: ImageOption?
	/// A state this connection observed before: the result says what changed since it.
	public var since: String?

	public init(target: Target? = nil, full: Bool? = nil, image: ImageOption? = nil, since: String? = nil) {
		self.target = target
		self.full = full
		self.image = image
		self.since = since
	}
}

public struct UiApp: Sendable, Codable, Equatable {
	public var id: String
	public var name: String
	public var pid: Int?

	public init(id: String, name: String, pid: Int?) {
		self.id = id
		self.name = name
		self.pid = pid
	}
}

public struct UiWindow: Sendable, Codable, Equatable {
	public var id: String
	public var title: String?
	/// What it is, by the node roles: "dialog" for a sheet, an alert or a panel. Absent: "window".
	public var role: String?
	/// In screen points: where the window sits.
	public var bounds: Rect

	public init(id: String, title: String?, role: String? = nil, bounds: Rect) {
		self.id = id
		self.title = title
		self.role = role
		self.bounds = bounds
	}
}

/// protocol.json's uiRoles: ARIA's names, which a driver maps its platform's roles onto. A role it cannot map is generic.
public let uiRoles: [String] = [
	"window", "dialog", "menu", "menuitem", "toolbar", "tab",
	"button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "slider", "combobox", "progressbar",
	"list", "listitem", "table", "row", "cell", "scrollarea",
	"image", "text", "heading", "group", "generic",
]

public enum UiFlag: String, Sendable, Codable, CaseIterable, Comparable {
	case focused, disabled, selected, checked, secure, offscreen

	public static func < (a: UiFlag, b: UiFlag) -> Bool {
		allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
	}
}

public struct UiNode: Sendable, Codable, Equatable {
	/// "@e12": good for as long as its element exists.
	public var ref: String
	public var role: String
	public var name: String?
	/// Never sent for a secure field.
	public var value: String?
	/// What else it says, beside its name: a row's secondary text, a help tag.
	public var desc: String?
	/// The app's own name for it: a macOS accessibility identifier.
	public var id: String?
	/// In the window's points, origin at its top left.
	public var bounds: Rect
	/// The nearest node above it in this list; absent at the top.
	public var parent: String?
	public var flags: [UiFlag]?
	/// The platform's own action names, for the perform step: "AXShowMenu", "AXIncrement".
	public var actions: [String]?

	public init(ref: String, role: String, name: String? = nil, value: String? = nil, desc: String? = nil, id: String? = nil, bounds: Rect, parent: String? = nil, flags: [UiFlag]? = nil, actions: [String]? = nil) {
		self.ref = ref
		self.role = role
		self.name = name
		self.value = value
		self.desc = desc
		self.id = id
		self.bounds = bounds
		self.parent = parent
		self.flags = flags
		self.actions = actions
	}
}

public struct UiDiff: Sendable, Codable, Equatable {
	public var added: [String]
	public var removed: [String]
	public var changed: [String]

	public init(added: [String], removed: [String], changed: [String]) {
		self.added = added
		self.removed = removed
		self.changed = changed
	}
}

/// A window's image, whole: at most maxChunkBytes before base64.
public struct UiImage: Sendable, Codable, Equatable {
	/// "png" or "jpeg".
	public var format: String
	/// Pixels. The image covers the window: a pixel is window.bounds' width / width points.
	public var width: Int
	public var height: Int
	public var data: Data

	public init(format: String, width: Int, height: Int, data: Data) {
		self.format = format
		self.width = width
		self.height = height
		self.data = data
	}
}

public struct UiObserveResult: Sendable, Codable, Equatable {
	public var state: String
	public var app: UiApp
	public var window: UiWindow
	public var nodes: [UiNode]
	public var diff: UiDiff?
	public var image: UiImage?
	/// Why nodes is empty though the window is not: ui.tree is off here. The image then comes, asked for or not.
	public var empty: String?
	public var truncated: Bool
}

/// A ref ("@e12") or a point [x, y] of whole points in the state's window.
public enum RefOrPoint: Sendable, Codable, Equatable {
	case ref(String)
	case point(Point)

	public init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if let s = try? c.decode(String.self) {
			guard isRef(s) else { throw decoder.corrupted("\(s.debugDescription) is not a ref (\"@e12\")") }
			self = .ref(s)
		} else if let p = try? c.decode(Point.self), p.isWhole {
			self = .point(p)
		} else {
			throw decoder.corrupted("a ref (\"@e12\") or a point [x, y] of whole window points")
		}
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.singleValueContainer()
		switch self {
		case .ref(let r): try c.encode(r)
		case .point(let p): try c.encode(p)
		}
	}
}

/// A ref is a string of "@" and more.
public func isRef(_ s: String) -> Bool { s.count > 1 && s.hasPrefix("@") }

extension Point {
	var isWhole: Bool { x == x.rounded() && y == y.rounded() }
}

public enum MouseButton: String, Sendable, Codable {
	case left, right
}

/// The system's own navigation, for the nav step.
public enum Nav: String, Sendable, Codable {
	case back, home
	case appSwitch = "app_switch"
}

/// One step of ui.act. On the wire each is an object named by its one verb key.
public enum Step: Sendable, Equatable, Codable {
	case press(String)
	case set(String, value: String)
	case perform(String, action: String)
	case click(RefOrPoint, button: MouseButton?, count: Int?)
	case type(String, into: String?)
	case key(String)
	case nav(Nav)
	case scroll(RefOrPoint, dx: Int?, dy: Int?)
	case drag([Point], ms: Int?)

	enum Keys: String, CodingKey {
		case press, set, value, perform, action, click, button, count, type, into, key, nav, scroll, dx, dy, drag, ms
	}

	static let verbs: [Keys] = [.press, .set, .perform, .click, .type, .key, .nav, .scroll, .drag]

	public init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		let present = Self.verbs.filter { c.contains($0) }
		guard present.count == 1, let verb = present.first else {
			throw decoder.corrupted("a step is exactly one of press, set, perform, click, type, key, nav, scroll or drag")
		}
		func ref(_ key: Keys) throws -> String {
			let r = try c.decode(String.self, forKey: key)
			guard isRef(r) else { throw decoder.corrupted("\(key.stringValue) is \(r.debugDescription), not a ref (\"@e12\")") }
			return r
		}
		switch verb {
		case .press: self = .press(try ref(.press))
		case .set: self = .set(try ref(.set), value: try c.decode(String.self, forKey: .value))
		case .perform: self = .perform(try ref(.perform), action: try c.decode(String.self, forKey: .action))
		case .click:
			let count = try c.decodeIfPresent(Int.self, forKey: .count)
			if let count, !(1...3).contains(count) { throw decoder.corrupted("a click's count is 1, 2 or 3") }
			self = .click(try c.decode(RefOrPoint.self, forKey: .click), button: try c.decodeIfPresent(MouseButton.self, forKey: .button), count: count)
		case .type: self = .type(try c.decode(String.self, forKey: .type), into: c.contains(.into) ? try ref(.into) : nil)
		case .key: self = .key(try c.decode(String.self, forKey: .key))
		case .nav: self = .nav(try c.decode(Nav.self, forKey: .nav))
		case .scroll: self = .scroll(try c.decode(RefOrPoint.self, forKey: .scroll), dx: try c.decodeIfPresent(Int.self, forKey: .dx), dy: try c.decodeIfPresent(Int.self, forKey: .dy))
		case .drag:
			let path = try c.decode([Point].self, forKey: .drag)
			guard path.count >= 2, path.allSatisfy(\.isWhole) else { throw decoder.corrupted("a drag is 2 or more points [x, y] of whole window points") }
			let ms = try c.decodeIfPresent(Int.self, forKey: .ms)
			if let ms, ms < 0 { throw decoder.corrupted("a drag's ms is 0 or more") }
			self = .drag(path, ms: ms)
		default: throw decoder.corrupted("unknown step")
		}
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.container(keyedBy: Keys.self)
		switch self {
		case .press(let r): try c.encode(r, forKey: .press)
		case .set(let r, let value):
			try c.encode(r, forKey: .set)
			try c.encode(value, forKey: .value)
		case .perform(let r, let action):
			try c.encode(r, forKey: .perform)
			try c.encode(action, forKey: .action)
		case .click(let at, let button, let count):
			try c.encode(at, forKey: .click)
			try c.encodeIfPresent(button, forKey: .button)
			try c.encodeIfPresent(count, forKey: .count)
		case .type(let text, let into):
			try c.encode(text, forKey: .type)
			try c.encodeIfPresent(into, forKey: .into)
		case .key(let chord): try c.encode(chord, forKey: .key)
		case .nav(let nav): try c.encode(nav, forKey: .nav)
		case .scroll(let at, let dx, let dy):
			try c.encode(at, forKey: .scroll)
			try c.encodeIfPresent(dx, forKey: .dx)
			try c.encodeIfPresent(dy, forKey: .dy)
		case .drag(let path, let ms):
			try c.encode(path, forKey: .drag)
			try c.encodeIfPresent(ms, forKey: .ms)
		}
	}

	/// The step's verb, for words.
	public var verb: String {
		switch self {
		case .press: return "press"
		case .set: return "set"
		case .perform: return "perform"
		case .click: return "click"
		case .type: return "type"
		case .key: return "key"
		case .nav: return "nav"
		case .scroll: return "scroll"
		case .drag: return "drag"
		}
	}

	/// The ref the step acts on: press, set, perform, a click or scroll at a ref, and type's into.
	public var ref: String? {
		switch self {
		case .press(let r), .set(let r, _), .perform(let r, _): return r
		case .click(.ref(let r), _, _), .scroll(.ref(let r), _, _): return r
		case .type(_, let into): return into
		default: return nil
		}
	}

	/// The point the step lands on: a click or scroll at a point, a drag's first point.
	public var point: Point? {
		switch self {
		case .click(.point(let p), _, _), .scroll(.point(let p), _, _): return p
		case .drag(let path, _): return path.first
		default: return nil
		}
	}
}

/// What must hold once the steps ran, polled on the computer until timeoutMs. text: some node's name or value holds it.
/// ref: the element exists. Both: that element's name or value holds the text. window: the act's app shows a window
/// that matches it (its main one), whose state the act then answers. gone: the opposite of each. One of text and ref
/// (or both), or window alone.
public struct Expect: Sendable, Codable, Equatable {
	public var text: String?
	public var ref: String?
	public var window: ExpectWindow?
	public var gone: Bool?
	/// Default defaultExpectMs, at most maxExpectMs.
	public var timeoutMs: Int?

	public init(text: String? = nil, ref: String? = nil, window: ExpectWindow? = nil, gone: Bool? = nil, timeoutMs: Int? = nil) {
		self.text = text
		self.ref = ref
		self.window = window
		self.gone = gone
		self.timeoutMs = timeoutMs
	}
}

/// A window of the act's app: its title holds title, and its role is role. At least one of the two.
public struct ExpectWindow: Sendable, Codable, Equatable {
	public var title: String?
	public var role: String?

	public init(title: String? = nil, role: String? = nil) {
		self.title = title
		self.role = role
	}
}

public struct UiActParams: Sendable, Codable, Equatable {
	/// Where keys and typing without a ref go. Default: the state's app and window, else the app in front.
	public var target: Target?
	/// The state the steps' points were read from. A step at a point needs it.
	public var state: String?
	public var steps: [Step]
	public var expect: Expect?
	/// Let steps take the foreground route, which moves the user's pointer and focus.
	public var foreground: Bool?

	public init(target: Target? = nil, state: String? = nil, steps: [Step], expect: Expect? = nil, foreground: Bool? = nil) {
		self.target = target
		self.state = state
		self.steps = steps
		self.expect = expect
		self.foreground = foreground
	}
}

/// How a step ran: through the accessibility tree, a web page's own protocol, input posted to the app in the
/// background, or input as if from the keyboard and mouse.
public enum Route: String, Sendable, Codable, CaseIterable {
	case semantic, page, background, foreground
}

public struct StepError: Sendable, Codable, Equatable {
	public var kind: ErrorKind
	public var message: String

	public init(kind: ErrorKind, message: String) {
		self.kind = kind
		self.message = message
	}
}

/// One step's answer: it ran by a route, verified or not, or it was refused (and the steps after it did not run).
public enum StepResult: Sendable, Equatable, Codable {
	case ran(route: Route, verified: Bool)
	case error(StepError)

	enum Keys: String, CodingKey { case route, verified, error }

	public init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		if let error = try c.decodeIfPresent(StepError.self, forKey: .error) {
			self = .error(error)
		} else {
			self = .ran(route: try c.decode(Route.self, forKey: .route), verified: try c.decode(Bool.self, forKey: .verified))
		}
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.container(keyedBy: Keys.self)
		switch self {
		case .ran(let route, let verified):
			try c.encode(route, forKey: .route)
			try c.encode(verified, forKey: .verified)
		case .error(let e): try c.encode(e, forKey: .error)
		}
	}
}

public enum ExpectOutcome: String, Sendable, Codable {
	case met, unmet
}

public struct UiActResult: Sendable, Codable, Equatable {
	/// One per step tried, in order. A refused step is the last.
	public var steps: [StepResult]
	/// The state after the steps, once the window settled. Absent when window is "closed".
	public var state: String?
	/// "closed": a step closed the act's window and its app has no window left (super+w on the last one), so there is
	/// no state to answer. The steps that ran keep their results. Absent while the act has a window.
	public var window: String? = nil
	/// The window's nodes or image changed between before the first step and the settled state. True when it closed.
	public var changed: Bool
	/// Whether the expect held in time; absent with no expect, or when a step was refused.
	public var expect: ExpectOutcome?
}
