import Foundation

// The operating system, as the core sees it. Every OS call sits behind these protocols, so the core's logic (refs and
// states, the route ladder, settle and expect) is tested against fakes without a GUI. ComputerdMac implements them on
// macOS.

/// An element of the OS's tree, as the backend keeps it: equal when it is the same element.
public struct ElementHandle: Hashable, @unchecked Sendable {
	public let base: AnyHashable

	public init(_ base: AnyHashable) {
		self.base = base
	}
}

/// One element as the backend read it, its role already mapped to the protocol's.
public struct RawNode: Sendable {
	public var handle: ElementHandle
	/// One of uiRoles.
	public var role: String
	public var name: String?
	public var value: String?
	/// What else it says, beside its name (AXHelp, or an AXDescription that is not its name).
	public var desc: String?
	/// The app's own name for it (AXIdentifier).
	public var identifier: String?
	/// In screen points; nil when the element has no frame.
	public var frame: Rect?
	/// The index of its parent in the snapshot's nodes.
	public var parent: Int?
	public var flags: Set<UiFlag>
	/// The platform's action names: "AXPress", "AXShowMenu".
	public var actions: [String]
	/// Its value can be set.
	public var settable: Bool
	/// It takes typed text: a text field, a text area, a search field, an editable combo box.
	public var textInput: Bool
	/// A document's text (a text area): it takes an edit as one only through the app's text system, so typed keys go
	/// before an accessibility insert.
	public var keysFirst: Bool

	public init(handle: ElementHandle, role: String, name: String? = nil, value: String? = nil, desc: String? = nil, identifier: String? = nil, frame: Rect?, parent: Int? = nil, flags: Set<UiFlag> = [], actions: [String] = [], settable: Bool = false, textInput: Bool = false, keysFirst: Bool = false) {
		self.handle = handle
		self.role = role
		self.name = name
		self.value = value
		self.desc = desc
		self.identifier = identifier
		self.frame = frame
		self.parent = parent
		self.flags = flags
		self.actions = actions
		self.settable = settable
		self.textInput = textInput
		self.keysFirst = keysFirst
	}
}

/// One walk of a window's tree, in walk order (a parent before its children).
public struct Snapshot: Sendable {
	public var nodes: [RawNode]
	/// The walk stopped at its node cap.
	public var truncated: Bool

	public init(nodes: [RawNode], truncated: Bool) {
		self.nodes = nodes
		self.truncated = truncated
	}
}

/// An app and one of its windows, found.
public struct ResolvedTarget: Sendable, Equatable {
	public var app: UiApp
	public var pid: Int32
	public var window: UiWindow

	public init(app: UiApp, pid: Int32, window: UiWindow) {
		self.app = app
		self.pid = pid
		self.window = window
	}

	/// A point of the window as a screen point.
	public func toScreen(_ p: Point) -> Point { Point(p.x + window.bounds.x, p.y + window.bounds.y) }
}

/// The accessibility tree: read it, and act through it.
public protocol Accessibility: Sendable {
	/// Accessibility is granted, or why not.
	var feature: Feature { get }
	/// The platform's name for an element's default action (AXPress), and for opening its menu (AXShowMenu).
	var pressAction: String { get }
	var menuAction: String { get }
	/// The platform's name for opening an item (AXOpen): an item that offers it (a Finder file) is renamed by keys.
	var openAction: String { get }
	/// Actions nearly every element lists, which do not make it worth showing in a compact view.
	var incidentalActions: Set<String> { get }
	/// The app and window a target names. Throws not_found for an app that is not running or a window it lacks.
	func resolve(_ target: Target?) throws -> ResolvedTarget
	/// The window's tree, at most maxNodes nodes.
	func snapshot(_ target: ResolvedTarget, maxNodes: Int) throws -> Snapshot
	/// The element still exists.
	func exists(_ element: ElementHandle) -> Bool
	/// Its frame now, in screen points.
	func frame(_ element: ElementHandle) -> Rect?
	/// Its value now; nil for a secure field or one with none.
	func value(_ element: ElementHandle) -> String?
	/// Runs one of the element's actions, by the platform's name.
	func perform(_ action: String, on element: ElementHandle) throws
	func setValue(_ value: String, on element: ElementHandle) throws
	/// Inserts text at the element's caret, replacing its selection.
	func insertText(_ text: String, on element: ElementHandle) throws
	func focus(_ element: ElementHandle) throws
	/// Selects the element, or the row or item it sits in, as a click on it would, where the app lets that selection be
	/// set (a Finder file, a table row). Throws RouteUnavailable where it does not. Answers the element now selected.
	func select(_ element: ElementHandle) throws -> ElementHandle
	/// The element is selected now.
	func isSelected(_ element: ElementHandle) -> Bool
	/// Asks the element's scroll area to show it.
	func scrollToVisible(_ element: ElementHandle) throws
	/// The element with keyboard focus in the target's app.
	func focused(_ target: ResolvedTarget) -> ElementHandle?
	/// The element takes typed text (a text field, a text area, a search field), as RawNode.textInput says of a node.
	func takesText(_ element: ElementHandle) -> Bool
	/// The id of the target's app's key window, the one its keyboard focus and its menus act in; nil when it has none.
	func keyWindow(_ target: ResolvedTarget) -> String?
	/// The enabled menu item a key chord would choose in the target's app (super+s is File > Save).
	func menuItem(for chord: KeyChord, in target: ResolvedTarget) -> ElementHandle?
}

/// An image, encoded.
public struct Image: Sendable, Equatable {
	public var data: Data
	public var format: String
	public var width: Int
	public var height: Int
	/// Image pixels per point.
	public var scale: Double

	public init(data: Data, format: String, width: Int, height: Int, scale: Double) {
		self.data = data
		self.format = format
		self.width = width
		self.height = height
		self.scale = scale
	}
}

/// Window and screen images.
public protocol Capture: Sendable {
	/// Screen Recording is granted, or why not.
	var feature: Feature { get }
	/// The app and window a target names, from the window server's list: how a window is found while the tree is off.
	/// Window ids are the same ones Accessibility.resolve gives. Throws not_found as resolve does.
	func resolve(_ target: Target?) throws -> ResolvedTarget
	/// The window's image, at most maxEdge pixels on its long edge and maxBytes long (JPEG at a lower quality when a PNG
	/// would be longer).
	func window(_ target: ResolvedTarget, maxEdge: Int, maxBytes: Int) async throws -> Image
	/// The main display's image, in pixels; a region in those pixels.
	func screen(region: Rect?) async throws -> Image
	/// A JPEG of the main display at most maxWidth pixels wide, for the live view.
	func frame(maxWidth: Int, quality: Int) async throws -> Image
	/// A cheap hash of how the window looks now; nil when it cannot be read.
	func windowHash(_ target: ResolvedTarget) async -> Int?
	/// The screen in points, and its scale.
	func screenInfo() -> ScreenInfo?
	/// Where the pointer is, in screen pixels.
	func cursor() -> Point?
}

/// A key and the modifiers held with it, as "super+shift+s" names it.
public struct KeyChord: Sendable, Equatable, Hashable {
	public enum Modifier: String, Sendable, CaseIterable, Comparable {
		case ctrl, alt, shift
		/// Command on a Mac.
		case cmd = "super"

		public static func < (a: Modifier, b: Modifier) -> Bool {
			allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
		}
	}

	public var modifiers: Set<Modifier>
	/// A name in the key table ("enter", "tab", "f5") or one printable character.
	public var key: String

	public init(modifiers: Set<Modifier>, key: String) {
		self.modifiers = modifiers
		self.key = key
	}
}

/// One way to post input: in the background to the target's app, or in the foreground as the keyboard and mouse.
/// Points are in screen points. A route that cannot do something here throws RouteUnavailable, and the next one tries.
public protocol InputRoute: Sendable {
	func click(at point: Point, button: MouseButton, count: Int, in target: ResolvedTarget) async throws
	func scroll(at point: Point, dx: Double, dy: Double, in target: ResolvedTarget) async throws
	func drag(_ path: [Point], ms: Int, in target: ResolvedTarget) async throws
	func type(_ text: String, in target: ResolvedTarget) async throws
	func key(_ chord: KeyChord, in target: ResolvedTarget) async throws
}

/// The computer's own keyboard and mouse, for input.actions: what a person's hands do, landing on the app in front.
/// Points are screen points. Each call is one event or a few; the batch paces them and keeps what is held.
public protocol RawInput: Sendable {
	/// Moves the pointer; with buttons held it drags them.
	func move(to point: Point, held: Set<InputButton>) async throws
	/// A press or a release where the pointer is, the clickState'th of a multiple click.
	func button(_ button: InputButton, down: Bool, at point: Point, clickState: Int) async throws
	/// dx and dy above 0 show what is right and below: in points, or in wheel clicks.
	func scroll(at point: Point, dx: Double, dy: Double, pixels: Bool) async throws
	/// A key down or up: a name in the key table or one printable character, with the modifiers held as they are.
	func key(_ key: String, down: Bool) async throws
	/// Text as the keyboard types it: newlines and tabs as their keys.
	func type(_ text: String) async throws
}

/// A person at the computer's own keyboard and mouse, apart from the input Computerd posts: what the foreground route's
/// take-over check reads, beside where the pointer is.
public protocol PersonInput: Sendable {
	/// When, on the platform's Clock, a person last pressed a key or a mouse button, turned the wheel or moved the
	/// pointer; nil when none was seen.
	func lastInput() -> Double?
}

/// Apps: list, launch, end.
public protocol Workspace: Sendable {
	/// apps.launch with background: true works here, or why not.
	var backgroundLaunch: Feature { get }
	/// The pid of the app in front, if any.
	var frontmost: Int32? { get }
	/// Whether the app is running: one whose last window closed still is, and a ui.act then answers window "closed".
	func running(_ id: String) -> Bool
	func list() -> AppsListResult
	func launch(_ id: String, url: String?, background: Bool) async throws
	func terminate(_ id: String) throws
}

/// Time, so settle and expect run on a fake clock in tests.
public protocol Clock: Sendable {
	/// Milliseconds on a monotonic clock.
	func now() -> Double
	func sleep(ms: Double) async throws
}

public struct SystemClock: Clock {
	public init() {}

	public func now() -> Double {
		Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
	}

	public func sleep(ms: Double) async throws {
		try await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000))
	}
}

/// Every OS piece a driver needs. A route whose feature is off is never taken.
public struct Platform: Sendable {
	public var accessibility: any Accessibility
	public var capture: any Capture
	public var workspace: any Workspace
	public var background: any InputRoute
	/// Background input works here, or why not (a missing SkyLight symbol, a missing grant).
	public var backgroundFeature: Feature
	public var foreground: any InputRoute
	/// Foreground input works here (the grant), apart from whether a call allows it.
	public var foregroundFeature: Feature
	/// The nav step works here, or why not.
	public var navFeature: Feature
	/// input.actions' keyboard and mouse. It is foreground input by nature, so foregroundFeature gates it too.
	public var raw: any RawInput
	/// A person's keyboard and mouse, for the take-over check of a ui act that takes the foreground route.
	public var person: any PersonInput
	public var clock: any Clock

	public init(accessibility: any Accessibility, capture: any Capture, workspace: any Workspace, background: any InputRoute, backgroundFeature: Feature, foreground: any InputRoute, foregroundFeature: Feature, navFeature: Feature, raw: any RawInput, person: any PersonInput, clock: any Clock = SystemClock()) {
		self.accessibility = accessibility
		self.capture = capture
		self.workspace = workspace
		self.background = background
		self.backgroundFeature = backgroundFeature
		self.foreground = foreground
		self.foregroundFeature = foregroundFeature
		self.navFeature = navFeature
		self.raw = raw
		self.person = person
		self.clock = clock
	}
}

/// What the Mac's owner allows every connection: which apps it may touch. Kept in Paths.policy; none means any app.
public struct Policy: Sendable, Equatable, Codable {
	/// Bundle ids a connection may touch; nil is any.
	public var apps: [String]?

	public init(apps: [String]? = nil) {
		self.apps = apps
	}

	public func allows(_ app: String) -> Bool {
		apps.map { $0.contains(app) } ?? true
	}

	public func check(_ app: String) throws {
		guard allows(app) else {
			throw RPCError.denied("this Mac's owner allows Computerd to touch only \(apps!.joined(separator: ", ")), not \(app)")
		}
	}
}
