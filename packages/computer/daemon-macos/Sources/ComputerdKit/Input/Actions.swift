import Foundation

// input.actions (wire.md, protocol.ts InputAction): a batch of pointer and key actions in screenshot pixels, checked
// whole before any runs, then run in order until the first failure. The checks follow checkActions (src/actions.ts) and
// the Linux daemon's Check (daemon/internal/desktop/check.go), so a batch means the same on every desktop.

/// input.actions' params: the batch, read by InputCheck rather than by type, so a bad action is a failed index.
public struct InputActionsParams: Sendable, Codable, Equatable {
	public var actions: JSON

	public init(actions: JSON) {
		self.actions = actions
	}
}

/// The action that stopped a batch, and why.
public struct InputFailure: Sendable, Codable, Equatable {
	public var index: Int
	public var kind: ErrorKind
	public var message: String

	public init(_ index: Int, _ kind: ErrorKind, _ message: String) {
		self.index = index
		self.kind = kind
		self.message = message
	}
}

public struct InputActionsResult: Sendable, Codable, Equatable {
	/// How many actions ran.
	public var done: Int
	public var failed: InputFailure?

	public init(done: Int, failed: InputFailure? = nil) {
		self.done = done
		self.failed = failed
	}
}

public enum InputButton: String, Sendable, CaseIterable {
	case left, right, middle
}

/// A point in screenshot pixels, whole.
public struct Pixel: Sendable, Equatable, Hashable {
	public var x: Int
	public var y: Int

	public init(_ x: Int, _ y: Int) {
		self.x = x
		self.y = y
	}
}

/// One checked action.
public struct InputAction: Sendable, Equatable {
	public var type: String
	public var at: Pixel?
	public var button: InputButton = .left
	public var count = 1
	public var keys: [String] = []
	public var path: [Pixel] = []
	public var dx: Double = 0
	public var dy: Double = 0
	/// unit px; else clicks.
	public var pixels = false
	public var repeats = 1
	public var ms = 0
	public var text = ""

	public init(type: String) {
		self.type = type
	}
}

public enum InputCheck {
	/// The most keys one action presses at once.
	public static let maxKeys = 16
	/// The most points one drag holds.
	public static let maxPath = 1000
	/// The most wheel clicks one scroll turns, each way, and the most pixels.
	public static let maxClicks = 10_000
	public static let maxScrollPixels = 1_000_000
	/// The most characters one type action takes.
	public static let maxTypeCharacters = 64 << 10
	/// JavaScript's Number.MAX_SAFE_INTEGER: the largest repeat checkActions reads as whole.
	static let maxSafeInteger = Double(1 << 53 - 1)

	/// The group each action type needs; "input" is any input group.
	static let groupOf: [String: String] = [
		"move": "input.pointer", "down": "input.pointer", "up": "input.pointer", "click": "input.pointer", "drag": "input.pointer", "scroll": "input.pointer",
		"key": "input.keys", "hold": "input.keys", "type": "input.keys",
		"tap": "input.touch", "long_press": "input.touch", "swipe": "input.touch", "pinch": "input.touch", "button": "input.touch",
		"wait": "input",
	]

	/// The fields each action type takes, past type.
	static let fieldsOf: [String: Set<String>] = [
		"move": ["at"], "down": ["button"], "up": ["button"],
		"click": ["at", "button", "count", "keys"],
		"drag": ["path", "button", "keys"],
		"scroll": ["at", "dx", "dy", "unit", "keys"],
		"key": ["keys", "repeat"], "hold": ["keys", "ms"], "type": ["text"],
		"tap": ["at", "count"], "long_press": ["at", "ms"], "swipe": ["path", "ms"], "pinch": ["at", "scale", "ms"], "button": ["name"],
		"wait": ["ms"],
	]

	/// The actions whose ms is a duration, summed toward maxBatchWaitMs.
	static let timed: Set<String> = ["wait", "hold", "long_press", "swipe", "pinch"]

	/// The batch, checked, or the first reason it must not run: its shape (invalid, or limit), each action's shape and
	/// keys (invalid), its group against groups (unsupported), a key's repeat (limit), and the summed durations (limit).
	public static func check(_ raw: JSON, groups: [Group]) -> ([InputAction], InputFailure?) {
		guard case .array(let list) = raw else { return ([], InputFailure(0, .invalid, "actions is not a list")) }
		if list.count > Limits.maxActions {
			return ([], InputFailure(Limits.maxActions, .limit, "a batch holds at most \(Limits.maxActions) actions; this one has \(list.count)"))
		}
		let names = Set(groups.map(\.rawValue))
		let anyInput = names.contains { $0.hasPrefix("input.") }
		var actions: [InputAction] = []
		var waited = 0
		for (i, one) in list.enumerated() {
			let a: InputAction
			do {
				a = try parse(one)
			} catch let e as RPCError {
				return ([], InputFailure(i, e.kind, "action \(i): \(e.message)"))
			} catch {
				return ([], InputFailure(i, .invalid, "action \(i): \(error)"))
			}
			if let bad = a.keys.first(where: { !isKey($0) }) {
				return ([], InputFailure(i, .invalid, "action \(i): \(bad.debugDescription) is not a key: a key is a name in the key table (protocol.json keys) or one printable ASCII character"))
			}
			let group = groupOf[a.type]!
			if group == "input" ? !anyInput : !names.contains(group) {
				let needs = group == "input" ? "an input group" : group
				return ([], InputFailure(i, .unsupported, "action \(i) (\(a.type)) needs \(needs), which this computer does not declare"))
			}
			if a.type == "key" && a.repeats > Limits.maxKeyRepeat {
				return ([], InputFailure(i, .limit, "action \(i): repeat \(a.repeats) is over \(Limits.maxKeyRepeat)"))
			}
			if timed.contains(a.type) {
				waited += a.ms
				if waited > Limits.maxBatchWaitMs {
					return ([], InputFailure(i, .limit, "the batch's durations reach \(waited) ms at action \(i), over \(Limits.maxBatchWaitMs) ms"))
				}
			}
			actions.append(a)
		}
		return (actions, nil)
	}

	public static func isKey(_ name: String) -> Bool {
		keyNames.contains(name) || KeyChord.printable(name)
	}

	/// One action, its shape checked. Throws invalid, or limit past a bound.
	static func parse(_ raw: JSON) throws -> InputAction {
		guard case .object(let fields) = raw else { throw RPCError.invalid("it is not an object") }
		guard case .string(let type)? = fields["type"], let allowed = fieldsOf[type] else {
			throw RPCError.invalid("type \(show(fields["type"])) is not an input action")
		}
		var a = InputAction(type: type)
		for name in fields.keys.sorted() where name != "type" && !allowed.contains(name) {
			throw RPCError.invalid("\(type) takes no field \(name.debugDescription)")
		}
		// A field is given when it is there at all, null too; a null is then no value.
		func has(_ name: String) -> Bool { fields[name] != nil }

		if has("at") {
			guard let p = pixel(fields["at"]!) else { throw RPCError.invalid("at \(show(fields["at"])) is not a point [x, y] of whole pixels") }
			a.at = p
		} else if ["move", "tap", "long_press", "pinch"].contains(type) {
			throw RPCError.invalid("at is required: a point [x, y]")
		}
		if has("button") {
			guard case .string(let name)? = fields["button"], let button = InputButton(rawValue: name) else {
				throw RPCError.invalid("button \(show(fields["button"])) is not left, right or middle")
			}
			a.button = button
		}
		if has("count") {
			let most = type == "tap" ? 2 : 3
			guard let n = whole(fields["count"]!), (1...most).contains(n) else { throw RPCError.invalid("count \(show(fields["count"])) is not 1 to \(most)") }
			a.count = n
		}
		let keysRequired = type == "key" || type == "hold"
		if has("keys") || keysRequired {
			guard case .array(let list)? = fields["keys"] else { throw RPCError.invalid("keys \(show(fields["keys"])) is not a list of keys") }
			var keys: [String] = []
			for item in list {
				guard case .string(let key) = item else { throw RPCError.invalid("keys \(show(fields["keys"])) is not a list of keys") }
				keys.append(key)
			}
			if keysRequired && keys.isEmpty { throw RPCError.invalid("keys [] is not a list of keys: name one or more") }
			if keys.count > maxKeys { throw RPCError.limit("\(keys.count) keys at once; at most \(maxKeys)") }
			a.keys = keys
		}
		if type == "drag" || type == "swipe" {
			guard case .array(let points)? = fields["path"], points.count >= 2 else { throw RPCError.invalid("path is not a list of 2 or more points") }
			if points.count > maxPath { throw RPCError.limit("a path of \(points.count) points; at most \(maxPath)") }
			for raw in points {
				guard let p = pixel(raw) else { throw RPCError.invalid("path point \(show(raw)) is not a point [x, y] of whole pixels") }
				a.path.append(p)
			}
		}
		if type == "scroll" {
			guard case .string(let unit)? = fields["unit"], unit == "clicks" || unit == "px" else {
				throw RPCError.invalid("unit \(show(fields["unit"])) is not clicks or px")
			}
			a.pixels = unit == "px"
			for name in ["dx", "dy"] where has(name) {
				guard let n = number(fields[name]!) else { throw RPCError.invalid("dx and dy are numbers") }
				if a.pixels {
					if abs(n) > Double(maxScrollPixels) { throw RPCError.limit("\(name) \(show(fields[name])): at most \(maxScrollPixels) pixels each way") }
				} else {
					if n != n.rounded(.towardZero) { throw RPCError.invalid("\(name) \(show(fields[name])) is not a whole number of clicks") }
					if abs(n) > Double(maxClicks) { throw RPCError.limit("\(name) \(show(fields[name])): at most \(maxClicks) clicks each way") }
				}
				if name == "dx" { a.dx = n } else { a.dy = n }
			}
		}
		if type == "key", has("repeat") {
			// Any safe integer above 0 is a repeat's shape; one over maxKeyRepeat is limit, checked after the group.
			guard let n = number(fields["repeat"]!), n == n.rounded(.towardZero), n >= 1, n <= maxSafeInteger else {
				throw RPCError.invalid("repeat \(show(fields["repeat"])) is not a whole number above 0")
			}
			a.repeats = n > Double(Int.max / 2) ? Int.max / 2 : Int(n)
		}
		if has("ms") || type == "hold" || type == "wait" {
			guard let raw = fields["ms"], let n = whole(raw), n >= 0 else { throw RPCError.invalid("ms \(show(fields["ms"])) is not a whole number of milliseconds") }
			a.ms = n
		}
		if type == "type" {
			guard case .string(let text)? = fields["text"] else { throw RPCError.invalid("text is not a string") }
			if text.count > maxTypeCharacters { throw RPCError.limit("text of \(text.count) characters; one type takes at most \(maxTypeCharacters)") }
			for (at, c) in text.enumerated() where !typeable(c) {
				let code = c.unicodeScalars.first.map { String(format: "U+%04X", $0.value) } ?? "?"
				throw RPCError.invalid("text has \(code) at character \(at), which no key types: type takes printable characters, newlines and tabs")
			}
			a.text = text
		}
		if type == "pinch" {
			guard let scale = fields["scale"].flatMap(number), scale > 0 else { throw RPCError.invalid("scale \(show(fields["scale"])) is not a number above 0") }
		}
		if type == "button" {
			guard case .string(let name)? = fields["name"], ["back", "home", "app_switch"].contains(name) else {
				throw RPCError.invalid("name \(show(fields["name"])) is not back, home or app_switch")
			}
		}
		return a
	}

	/// A character a key types: printable, a newline or a tab. Control characters and a lone carriage return are not.
	static func typeable(_ c: Character) -> Bool {
		if c == "\n" || c == "\t" { return true }
		return !c.unicodeScalars.contains { $0.properties.generalCategory == .control }
	}

	static func number(_ raw: JSON) -> Double? {
		switch raw {
		case .int(let i): return Double(i)
		case .double(let d): return d.isFinite ? d : nil
		default: return nil
		}
	}

	/// A whole number in Int32's range.
	static func whole(_ raw: JSON) -> Int? {
		guard let n = number(raw), n == n.rounded(.towardZero), abs(n) <= Double(Int32.max) else { return nil }
		return Int(n)
	}

	static func pixel(_ raw: JSON) -> Pixel? {
		guard case .array(let xy) = raw, xy.count == 2, let x = whole(xy[0]), let y = whole(xy[1]) else { return nil }
		return Pixel(x, y)
	}

	static func show(_ raw: JSON?) -> String {
		guard let raw else { return "undefined" }
		let text = (try? Coders.encode(raw)).map { String(decoding: $0, as: UTF8.self) } ?? "?"
		return text.count > 60 ? String(text.prefix(60)) + "..." : text
	}
}
