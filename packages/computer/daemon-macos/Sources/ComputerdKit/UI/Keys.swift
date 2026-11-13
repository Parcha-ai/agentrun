/// The protocol's key table (protocol.json keys). A chord is names from it, or one printable character, joined by "+".
/// A test holds it equal to protocol.json.
public let keyNames: [String] = [
	"enter", "tab", "space", "backspace", "delete", "escape", "insert",
	"up", "down", "left", "right", "home", "end", "pageup", "pagedown",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
	"shift", "ctrl", "alt", "super", "capslock",
]

extension KeyChord {
	/// Reads "super+s", "shift+tab", "enter" or "a", as the protocol writes them. Every name but the last is a modifier
	/// (shift, ctrl, alt, super); a modifier alone is a press of that key.
	public static func parse(_ text: String) throws -> KeyChord {
		// The last key may be "+" itself: "shift++" is shift and "+", and "+" alone is the key.
		let names: [String]
		if text == "+" {
			names = ["+"]
		} else if text.hasSuffix("++") {
			names = String(text.dropLast(2)).split(separator: "+", omittingEmptySubsequences: false).map(String.init) + ["+"]
		} else {
			names = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
		}
		guard !text.isEmpty, let last = names.last else { throw wrong(text) }
		for name in names where !keyNames.contains(name) && !printable(name) { throw wrong(text) }
		var modifiers = Set<Modifier>()
		for name in names.dropLast() {
			guard let modifier = Modifier(rawValue: name) else {
				throw RPCError.invalid("key \(text.debugDescription): \(name) is not a modifier; a chord's names before the last are shift, ctrl, alt or super")
			}
			modifiers.insert(modifier)
		}
		return KeyChord(modifiers: modifiers, key: last)
	}

	static func printable(_ name: String) -> Bool {
		guard name.unicodeScalars.count == 1, let v = name.unicodeScalars.first?.value else { return false }
		return v >= 0x21 && v <= 0x7e
	}

	static func wrong(_ text: String) -> RPCError {
		RPCError.invalid("key \(text.debugDescription): each name joined by \"+\" is one of the key table's (protocol.json keys) or one printable character")
	}

	/// The chord as the protocol writes it: modifiers in a fixed order, then the key.
	public var text: String {
		(modifiers.sorted().map(\.rawValue) + [key]).joined(separator: "+")
	}
}
