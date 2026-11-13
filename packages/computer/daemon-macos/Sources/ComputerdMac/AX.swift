#if os(macOS)
import AppKit
import ApplicationServices
import ComputerdKit
import Foundation

/// An accessibility element as a handle: equal when CoreFoundation says it is the same element.
struct AXRef: Hashable, @unchecked Sendable {
	let element: AXUIElement

	static func == (a: AXRef, b: AXRef) -> Bool { CFEqual(a.element, b.element) }

	func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

extension ElementHandle {
	init(ax element: AXUIElement) { self.init(AXRef(element: element)) }

	var ax: AXUIElement { (base.base as! AXRef).element }
}

/// Reading and acting on accessibility elements, every call bounded by the messaging timeout.
enum AX {
	/// The longest one call to another app waits: a hung app costs a second, not the default six.
	static let messagingTimeout: Float = 1.0

	static func copy(_ e: AXUIElement, _ attribute: String) -> AnyObject? {
		var value: AnyObject?
		guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success else { return nil }
		return value
	}

	/// Several attributes in one round trip to the app; a missing one is nil.
	static func copy(_ e: AXUIElement, _ attributes: [String]) -> [AnyObject?] {
		var values: CFArray?
		let err = AXUIElementCopyMultipleAttributeValues(e, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
		guard err == .success, let array = values as? [AnyObject], array.count == attributes.count else {
			return Array(repeating: nil, count: attributes.count)
		}
		return array.map { v in
			if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
			if v is NSNull { return nil }
			return v
		}
	}

	static func string(_ v: AnyObject?) -> String? {
		guard let s = v as? String, !s.isEmpty else { return nil }
		return s
	}

	static func bool(_ v: AnyObject?) -> Bool? { (v as? NSNumber)?.boolValue }

	static func point(_ v: AnyObject?) -> CGPoint? {
		guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
		var p = CGPoint.zero
		return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
	}

	static func size(_ v: AnyObject?) -> CGSize? {
		guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
		var s = CGSize.zero
		return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
	}

	static func elements(_ v: AnyObject?) -> [AXUIElement] {
		guard let array = v as? [AnyObject] else { return [] }
		return array.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
	}

	static func element(_ v: AnyObject?) -> AXUIElement? {
		guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
		return (v as! AXUIElement)
	}

	static func frame(_ e: AXUIElement) -> Rect? {
		let v = copy(e, [kAXPositionAttribute, kAXSizeAttribute])
		guard let p = point(v[0]), let s = size(v[1]) else { return nil }
		return Rect(Double(p.x), Double(p.y), Double(s.width), Double(s.height))
	}

	static func actions(_ e: AXUIElement) -> [String] {
		var names: CFArray?
		guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
		return list
	}

	static func settable(_ e: AXUIElement, _ attribute: String) -> Bool {
		var settable: DarwinBoolean = false
		return AXUIElementIsAttributeSettable(e, attribute as CFString, &settable) == .success && settable.boolValue
	}

	/// An AXError as the engine takes it: gone is stale, a refusal (nothing was sent) lets the next route try.
	static func check(_ err: AXError, _ what: String) throws {
		switch err {
		case .success: return
		case .invalidUIElement: throw RPCError.stale("\(what): the element is gone. Observe again for fresh refs")
		case .apiDisabled: throw RPCError.denied("\(what): Accessibility is not granted to Computerd")
		// The app has the request and did not answer in time (a press that opens a modal answers late): it was sent, so
		// its effect tells whether it ran, and no other route sends it again.
		case .cannotComplete: return
		case .actionUnsupported, .attributeUnsupported: throw RouteUnavailable("\(what): the element does not support it")
		default: throw RouteUnavailable("\(what) failed (AXError \(err.rawValue))")
		}
	}

	/// A value as the protocol shows it: text as it is, a toggle as "on" or "off", a number in its shortest form.
	static func text(_ v: AnyObject?, role: String) -> String? {
		if let s = v as? String { return s.isEmpty ? nil : String(s.prefix(maxValueChars)) }
		guard let n = v as? NSNumber else { return nil }
		if Roles.toggles.contains(role) { return n.doubleValue != 0 ? "on" : "off" }
		let d = n.doubleValue
		if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
		return String(d)
	}

	/// The longest value a node carries: a document's text is cut here.
	static let maxValueChars = 4096
}

/// The accessibility tree of macOS apps.
final class MacAccessibility: Accessibility, @unchecked Sendable {
	let sky: SkyLight
	/// The apps told to build their tree for us (Electron's AXManualAccessibility), by pid.
	private var manual = Set<pid_t>()
	private let lock = NSLock()
	/// The longest one snapshot walks before it answers with what it has.
	let walkSeconds: Double = 5

	init(sky: SkyLight) {
		self.sky = sky
		AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), AX.messagingTimeout)
	}

	var feature: Feature {
		guard AXIsProcessTrusted() else {
			return .off("Accessibility is not granted to Computerd: allow it in System Settings > Privacy & Security > Accessibility")
		}
		guard sky.getWindowFn != nil else {
			return .off("_AXUIElementGetWindow is missing on macOS \(macOSVersion), so Computerd cannot tell windows apart")
		}
		return .on
	}

	let pressAction = kAXPressAction as String
	let menuAction = kAXShowMenuAction as String
	let openAction = "AXOpen"
	let incidentalActions: Set<String> = [kAXShowMenuAction as String, "AXScrollToVisible", kAXRaiseAction as String]

	// MARK: apps and windows

	/// The app a target names, or the one in front: for both ways of finding a window (the tree's and the window list's).
	static func runningApp(_ id: String?) throws -> NSRunningApplication {
		if let id {
			guard let found = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { !$0.isTerminated }) else {
				throw RPCError.notFound("\(id) is not running: start it with apps.launch")
			}
			return found
		}
		guard let front = NSWorkspace.shared.frontmostApplication else { throw RPCError.notFound("no app is in front") }
		return front
	}

	/// The app's windows as accessibility elements: its window list, then its focused and main windows, which an app's
	/// first-run window (Notes' "Welcome to Notes") can be without being in the list.
	func windows(_ pid: pid_t) -> [AXUIElement] {
		Self.windows(of: AXUIElementCreateApplication(pid))
	}

	static func windows(of root: AXUIElement) -> [AXUIElement] {
		let listed = AX.elements(AX.copy(root, kAXWindowsAttribute))
		let named = [kAXFocusedWindowAttribute, kAXMainWindowAttribute].compactMap { AX.element(AX.copy(root, $0)) }
		return listed + named.filter { window in !listed.contains { CFEqual($0, window) } }
	}

	/// The accessibility element of a window the target names.
	func window(_ target: ResolvedTarget) throws -> AXUIElement {
		guard let found = windows(target.pid).first(where: { sky.windowID($0).map { String($0) } == target.window.id }) else {
			throw RPCError.notFound("\(target.app.id) has no window \(target.window.id) any more: observe again")
		}
		return found
	}

	/// Electron builds its tree only when asked; Chrome answers unsupported and builds it for any client.
	func askForTree(_ app: AXUIElement, _ pid: pid_t) {
		lock.lock()
		let first = manual.insert(pid).inserted
		lock.unlock()
		guard first else { return }
		_ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
	}

	func resolve(_ target: Target?) throws -> ResolvedTarget {
		let app = try Self.runningApp(target?.app)
		let pid = app.processIdentifier
		let id = app.bundleIdentifier ?? "pid.\(pid)"
		let root = AXUIElementCreateApplication(pid)
		askForTree(root, pid)
		let all = Self.windows(of: root)
		let element: AXUIElement
		if let wanted = target?.window {
			guard let found = all.first(where: { sky.windowID($0).map { String($0) } == wanted }) else {
				throw RPCError.notFound("\(id) has no window \(wanted): observe it without a window for its main one")
			}
			element = found
		} else {
			let main = AX.element(AX.copy(root, kAXFocusedWindowAttribute)) ?? AX.element(AX.copy(root, kAXMainWindowAttribute))
			guard let chosen = main ?? all.first else {
				throw RPCError.notFound("\(id) has no window open\(app.isHidden ? ": it is hidden" : "")")
			}
			element = chosen
		}
		guard let wid = sky.windowID(element) else { throw RPCError.notFound("\(id)'s window has no window server id") }
		guard let bounds = AX.frame(element) else { throw RPCError.notFound("\(id)'s window has no frame") }
		let title = AX.string(AX.copy(element, kAXTitleAttribute))
		let kind = AX.copy(element, [kAXRoleAttribute, kAXSubroleAttribute])
		let role = Roles.window(role: AX.string(kind[0]), subrole: AX.string(kind[1]))
		return ResolvedTarget(app: UiApp(id: id, name: app.localizedName ?? id, pid: Int(pid)), pid: pid, window: UiWindow(id: String(wid), title: title, role: role, bounds: bounds))
	}

	// MARK: the tree

	static let walked: [String] = [
		kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
		kAXIdentifierAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
		kAXSelectedAttribute, kAXChildrenAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute,
	]

	func snapshot(_ target: ResolvedTarget, maxNodes: Int) throws -> Snapshot {
		let root = try window(target)
		let until = Date().addingTimeInterval(walkSeconds)
		let bounds = target.window.bounds
		var nodes: [RawNode] = []
		var truncated = false
		// Depth first, a parent before its children, children in the app's order.
		var stack: [(element: AXUIElement, parent: Int?, depth: Int)] = [(root, nil, 0)]
		while case let (element, parent, depth)? = stack.popLast() {
			if nodes.count >= maxNodes || Date() >= until {
				truncated = true
				break
			}
			let v = AX.copy(element, Self.walked)
			let axRole = AX.string(v[0])
			let subrole = AX.string(v[1])
			let parentRole = parent.map { nodes[$0].role }
			let role = Roles.map(role: axRole, subrole: subrole, parentRole: parentRole)
			let secure = subrole == "AXSecureTextField"
			var frame: Rect?
			if let p = AX.point(v[6]), let s = AX.size(v[7]) { frame = Rect(Double(p.x), Double(p.y), Double(s.width), Double(s.height)) }
			var flags = Set<UiFlag>()
			if AX.bool(v[9]) == true { flags.insert(.focused) }
			if AX.bool(v[8]) == false { flags.insert(.disabled) }
			if AX.bool(v[10]) == true { flags.insert(.selected) }
			if secure { flags.insert(.secure) }
			var value = secure ? nil : AX.text(v[4], role: role)
			if Roles.toggles.contains(role) {
				if value == "on" { flags.insert(.checked) }
				value = nil
			}
			if let frame, !frame.overlaps(bounds) { flags.insert(.offscreen) }
			let title = AX.string(v[2])
			let description = AX.string(v[3])
			var name = title ?? description
			if role == "text", name == nil {
				name = value
				value = nil
			}
			if name == nil, role == "textbox" || role == "searchbox" { name = AX.string(v[12]) }
			// desc: what it says beside its name. A description that is not already the name, else its help tag.
			let desc = [description, AX.string(v[13])].compactMap { $0 }.first { !$0.isEmpty && $0 != name }
			let textInput = axRole.map { Roles.textInput.contains($0) } == true || subrole == "AXSearchField"
			let actions = AX.actions(element)
			// An item that opens (a Finder file's name in a list) says its value is settable, takes a set value into the
			// field and renames nothing: on the mini, three runs. Its name changes only by its own rename, by keys.
			let settable = !actions.contains("AXOpen") && AX.settable(element, kAXValueAttribute)
			nodes.append(RawNode(
				handle: ElementHandle(ax: element), role: role, name: name, value: value, desc: desc, identifier: AX.string(v[5]), frame: frame,
				parent: parent, flags: flags, actions: actions, settable: settable, textInput: textInput,
				keysFirst: axRole == kAXTextAreaRole as String
			))
			guard depth < 64 else { continue }
			let me = nodes.count - 1
			for child in AX.elements(v[11]).reversed() { stack.append((child, me, depth + 1)) }
		}
		if !stack.isEmpty { truncated = true }
		return Snapshot(nodes: nodes, truncated: truncated)
	}

	func exists(_ element: ElementHandle) -> Bool {
		var value: AnyObject?
		return AXUIElementCopyAttributeValue(element.ax, kAXRoleAttribute as CFString, &value) != .invalidUIElement
	}

	func frame(_ element: ElementHandle) -> Rect? { AX.frame(element.ax) }

	func value(_ element: ElementHandle) -> String? {
		let v = AX.copy(element.ax, [kAXRoleAttribute, kAXSubroleAttribute, kAXValueAttribute])
		if AX.string(v[1]) == "AXSecureTextField" { return nil }
		let role = Roles.map(role: AX.string(v[0]), subrole: AX.string(v[1]), parentRole: nil)
		return AX.text(v[2], role: role)
	}

	func perform(_ action: String, on element: ElementHandle) throws {
		try AX.check(AXUIElementPerformAction(element.ax, action as CFString), action)
	}

	func setValue(_ value: String, on element: ElementHandle) throws {
		let e = element.ax
		let current = AX.copy(e, kAXValueAttribute)
		let new: AnyObject
		if current is NSNumber, !(current is String) {
			switch value {
			case "on": new = NSNumber(value: 1)
			case "off": new = NSNumber(value: 0)
			default:
				guard let number = Double(value) else {
					throw RPCError.invalid("set: this element holds a number, and \(value.debugDescription) is not one (or \"on\", \"off\")")
				}
				new = NSNumber(value: number)
			}
		} else {
			new = value as CFString
		}
		try AX.check(AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, new), "set")
	}

	func insertText(_ text: String, on element: ElementHandle) throws {
		try AX.check(AXUIElementSetAttributeValue(element.ax, kAXSelectedTextAttribute as CFString, text as CFString), "type")
	}

	func focus(_ element: ElementHandle) throws {
		try AX.check(AXUIElementSetAttributeValue(element.ax, kAXFocusedAttribute as CFString, kCFBooleanTrue), "focus")
	}

	func select(_ element: ElementHandle) throws -> ElementHandle {
		// The element, then the two elements above it (a file's image sits in its item, a cell in its row): the first
		// whose AXSelected can be set is set; else the first whose parent can take it as its selected children.
		var chain: [AXUIElement] = [element.ax]
		for _ in 0..<2 {
			guard let parent = AX.element(AX.copy(chain[chain.count - 1], kAXParentAttribute)) else { break }
			chain.append(parent)
		}
		for e in chain where Self.settable(e, kAXSelectedAttribute) {
			try AX.check(AXUIElementSetAttributeValue(e, kAXSelectedAttribute as CFString, kCFBooleanTrue), "select")
			return ElementHandle(ax: e)
		}
		for e in chain {
			guard let parent = AX.element(AX.copy(e, kAXParentAttribute)), Self.settable(parent, kAXSelectedChildrenAttribute) else { continue }
			try AX.check(AXUIElementSetAttributeValue(parent, kAXSelectedChildrenAttribute as CFString, [e] as CFArray), "select")
			return ElementHandle(ax: e)
		}
		throw RouteUnavailable("neither it nor the row or item it sits in can be selected through Accessibility")
	}

	func isSelected(_ element: ElementHandle) -> Bool {
		if AX.bool(AX.copy(element.ax, kAXSelectedAttribute)) == true { return true }
		guard let parent = AX.element(AX.copy(element.ax, kAXParentAttribute)) else { return false }
		return AX.elements(AX.copy(parent, kAXSelectedChildrenAttribute)).contains { CFEqual($0, element.ax) }
	}

	static func settable(_ e: AXUIElement, _ attribute: String) -> Bool {
		var settable: DarwinBoolean = false
		return AXUIElementIsAttributeSettable(e, attribute as CFString, &settable) == .success && settable.boolValue
	}

	func scrollToVisible(_ element: ElementHandle) throws {
		try AX.check(AXUIElementPerformAction(element.ax, "AXScrollToVisible" as CFString), "AXScrollToVisible")
	}

	func focused(_ target: ResolvedTarget) -> ElementHandle? {
		AX.element(AX.copy(AXUIElementCreateApplication(target.pid), kAXFocusedUIElementAttribute)).map { ElementHandle(ax: $0) }
	}

	func takesText(_ element: ElementHandle) -> Bool {
		let v = AX.copy(element.ax, [kAXRoleAttribute, kAXSubroleAttribute])
		return AX.string(v[0]).map { Roles.textInput.contains($0) } == true || AX.string(v[1]) == "AXSearchField"
	}

	func keyWindow(_ target: ResolvedTarget) -> String? {
		AX.element(AX.copy(AXUIElementCreateApplication(target.pid), kAXFocusedWindowAttribute)).flatMap(sky.windowID).map { String($0) }
	}

	// MARK: menus

	static let menuWalked: [String] = [kAXChildrenAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute, kAXEnabledAttribute]

	/// The enabled menu item whose key equivalent is the chord. A background app's menus take no keys, so the engine
	/// presses the item instead. An item that reads disabled is left to the keys: an app validates its menus only in
	/// front, so a background app's items all read disabled (Back, Save, Close on the mini), and a press of TextEdit's
	/// disabled Save saved nothing.
	func menuItem(for chord: KeyChord, in target: ResolvedTarget) -> ElementHandle? {
		guard chord.modifiers.contains(.cmd), chord.key.count == 1 else { return nil }
		// kAXMenuItemModifier: none is command alone; shift 1, option 2, control 4.
		var modifiers = 0
		if chord.modifiers.contains(.shift) { modifiers |= 1 }
		if chord.modifiers.contains(.alt) { modifiers |= 2 }
		if chord.modifiers.contains(.ctrl) { modifiers |= 4 }
		let key = chord.key.uppercased()
		guard let bar = AX.element(AX.copy(AXUIElementCreateApplication(target.pid), kAXMenuBarAttribute)) else {
			log("menu item for \(chord.text) in \(target.app.id): the app shows no menu bar")
			return nil
		}
		var stack: [(AXUIElement, Int)] = [(bar, 0)]
		var seen = 0
		var near: [String] = []
		while case let (element, depth)? = stack.popLast(), seen < 4000 {
			seen += 1
			let v = AX.copy(element, Self.menuWalked)
			if let char = AX.string(v[1]), char.uppercased() == key {
				let mods = (v[2] as? NSNumber)?.intValue ?? 0
				let enabled = AX.bool(v[3]) != false
				if mods == modifiers && enabled { return ElementHandle(ax: element) }
				near.append("modifiers \(mods), enabled \(enabled)")
			}
			guard depth < 6 else { continue }
			for child in AX.elements(v[0]).reversed() { stack.append((child, depth + 1)) }
		}
		log("menu item for \(chord.text) in \(target.app.id): none of \(seen) elements matched; items on \(key): \(near.isEmpty ? "none" : near.joined(separator: "; "))")
		return nil
	}
}

extension Rect {
	func overlaps(_ other: Rect) -> Bool {
		x < other.x + other.w && other.x < x + w && y < other.y + other.h && other.y < y + h
	}
}
#endif
