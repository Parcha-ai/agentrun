#if os(macOS)
import ComputerdKit
import CoreGraphics

/// The virtual key codes of a US ANSI keyboard, for the protocol's key names and printable characters. A character a
/// person types with shift held ("A", "!") is its key with shift.
enum Keycodes {
	static let named: [String: CGKeyCode] = [
		"enter": 0x24, "tab": 0x30, "space": 0x31, "backspace": 0x33, "delete": 0x75, "escape": 0x35, "insert": 0x72,
		"up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C, "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
		"f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65,
		"f10": 0x6D, "f11": 0x67, "f12": 0x6F,
		"shift": 0x38, "ctrl": 0x3B, "alt": 0x3A, "super": 0x37, "capslock": 0x39,
	]

	static let unshifted: [Character: CGKeyCode] = [
		"a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
		"b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
		"4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
		"o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
		"\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
	]

	/// What shift makes of each key on a US keyboard.
	static let shifted: [Character: Character] = [
		"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
		"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
	]

	/// The key code for a key name or printable character, and whether shift goes with it.
	static func code(_ key: String) -> (code: CGKeyCode, shift: Bool)? {
		if let code = named[key] { return (code, false) }
		guard key.count == 1, let c = key.first else { return nil }
		if let code = unshifted[c] { return (code, false) }
		if c.isUppercase, let lower = c.lowercased().first, let code = unshifted[lower] { return (code, true) }
		if let base = shifted[c], let code = unshifted[base] { return (code, true) }
		return nil
	}

	static let modifierCodes: [KeyChord.Modifier: CGKeyCode] = [.ctrl: 0x3B, .alt: 0x3A, .shift: 0x38, .cmd: 0x37]

	static let modifierFlags: [KeyChord.Modifier: CGEventFlags] = [.ctrl: .maskControl, .alt: .maskAlternate, .shift: .maskShift, .cmd: .maskCommand]

	/// The key events of a chord: each modifier down in order, the key down and up, the modifiers up in reverse.
	static func events(_ chord: KeyChord, source: CGEventSource?) throws -> [CGEvent] {
		guard let found = Keycodes.code(chord.key) else {
			throw RPCError.invalid("key \(chord.text.debugDescription): \(chord.key) has no key on a US keyboard")
		}
		let (code, shift) = found
		var modifiers = chord.modifiers.sorted()
		if shift, !chord.modifiers.contains(.shift) { modifiers.append(.shift) }
		// A modifier named as the key is pressed as a key, not held as well.
		modifiers.removeAll { modifierCodes[$0] == code }
		var flags: CGEventFlags = []
		var events: [CGEvent] = []
		func make(_ key: CGKeyCode, _ down: Bool) throws {
			guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else {
				throw RouteUnavailable("the system made no key event")
			}
			event.flags = flags
			events.append(event)
		}
		for m in modifiers {
			flags.insert(modifierFlags[m]!)
			try make(modifierCodes[m]!, true)
		}
		try make(code, true)
		try make(code, false)
		for m in modifiers.reversed() {
			flags.remove(modifierFlags[m]!)
			try make(modifierCodes[m]!, false)
		}
		return events
	}

	/// Text as key events carrying their characters, at most 20 UTF-16 units each (more is dropped by some apps).
	static func textEvents(_ text: String, source: CGEventSource?) throws -> [CGEvent] {
		var chunks: [[UniChar]] = []
		var current: [UniChar] = []
		for character in text {
			let units = Array(String(character).utf16)
			if !current.isEmpty, current.count + units.count > 20 {
				chunks.append(current)
				current = []
			}
			current.append(contentsOf: units)
		}
		if !current.isEmpty { chunks.append(current) }
		var events: [CGEvent] = []
		for chunk in chunks {
			for down in [true, false] {
				guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
					throw RouteUnavailable("the system made no key event")
				}
				chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
				events.append(event)
			}
		}
		return events
	}
}
#endif
