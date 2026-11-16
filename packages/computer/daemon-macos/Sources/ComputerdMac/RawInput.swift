#if os(macOS)
import ComputerdKit
import CoreGraphics
import Foundation

/// input.actions' keyboard and mouse: events posted at the HID tap, as a person's hands make them. They move the real
/// pointer and land on the app in front. The modifiers held stay held across batches, as the keys do, and every event
/// carries them, so a click with super held is a super-click.
final class HIDInput: RawInput, @unchecked Sendable {
	static let shared = HIDInput()

	private let lock = NSLock()
	private var flags: CGEventFlags = []
	/// Characters pressed with the shift they imply ("A", "!"), so their release lets it go.
	private var shifted: Set<String> = []

	static let modifierFlags: [String: CGEventFlags] = [
		"shift": .maskShift, "ctrl": .maskControl, "alt": .maskAlternate, "super": .maskCommand, "capslock": .maskAlphaShift,
	]

	private var held: CGEventFlags { lock.withLock { flags } }

	static func cgButton(_ b: InputButton) -> CGMouseButton {
		switch b {
		case .left: return .left
		case .right: return .right
		case .middle: return .center
		}
	}

	func post(_ type: CGEventType, at point: Point, button: InputButton, clickState: Int) throws {
		guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: point.x, y: point.y), mouseButton: Self.cgButton(button)) else {
			throw RPCError.unsupported("the system made no mouse event")
		}
		if clickState > 0 { e.setIntegerValueField(.mouseEventClickState, value: Int64(clickState)) }
		if button == .middle { e.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
		e.flags = held
		e.post(tap: .cghidEventTap)
	}

	func move(to point: Point, held buttons: Set<InputButton>) async throws {
		let (type, button): (CGEventType, InputButton) =
			buttons.contains(.left) ? (.leftMouseDragged, .left)
			: buttons.contains(.right) ? (.rightMouseDragged, .right)
			: buttons.contains(.middle) ? (.otherMouseDragged, .middle)
			: (.mouseMoved, .left)
		try await InputQueue.run { try self.post(type, at: point, button: button, clickState: buttons.isEmpty ? 0 : 1) }
		// The window server moves the pointer after the event is posted, not when: wait (up to 100 ms) until it reads
		// where the event put it, so the next action, and the take-over check before it, see the pointer where it is.
		for _ in 0..<50 {
			if let at = CGEvent(source: nil)?.location, abs(at.x - point.x) < 1, abs(at.y - point.y) < 1 { return }
			try await Task.sleep(nanoseconds: 2_000_000)
		}
	}

	func button(_ button: InputButton, down: Bool, at point: Point, clickState: Int) async throws {
		let type: CGEventType
		switch (button, down) {
		case (.left, true): type = .leftMouseDown
		case (.left, false): type = .leftMouseUp
		case (.right, true): type = .rightMouseDown
		case (.right, false): type = .rightMouseUp
		case (.middle, true): type = .otherMouseDown
		case (.middle, false): type = .otherMouseUp
		}
		try await InputQueue.run { try self.post(type, at: point, button: button, clickState: clickState) }
	}

	func scroll(at point: Point, dx: Double, dy: Double, pixels: Bool) async throws {
		let flags = held
		// Points go out whole; wheel clicks are counted whole.
		let (x, y) = pixels ? (dx.rounded(), dy.rounded()) : (dx, dy)
		try await InputQueue.run {
			try Gestures.scroll(at: CGPoint(x: point.x, y: point.y), dx: x, dy: y, pixels: pixels, fail: { RPCError.unsupported($0) }) {
				$0.flags = flags
				$0.post(tap: .cghidEventTap)
			}
		}
	}

	func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) throws {
		guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
			throw RPCError.unsupported("the system made no key event")
		}
		e.flags = flags
		e.post(tap: .cghidEventTap)
	}

	func key(_ key: String, down: Bool) async throws {
		guard let (code, needsShift) = Keycodes.code(key) else {
			throw RPCError.invalid("\(key.debugDescription) has no key on a US keyboard")
		}
		try await InputQueue.run {
			try self.lock.withLock {
				if let flag = Self.modifierFlags[key] {
					if down { self.flags.insert(flag) } else { self.flags.remove(flag) }
					try self.keyEvent(code, down: down, flags: self.flags)
					return
				}
				let shiftCode = Keycodes.named["shift"]!
				if down, needsShift, !self.flags.contains(.maskShift) {
					try self.keyEvent(shiftCode, down: true, flags: self.flags.union(.maskShift))
					self.shifted.insert(key)
				}
				let implied = self.shifted.contains(key)
				try self.keyEvent(code, down: down, flags: implied ? self.flags.union(.maskShift) : self.flags)
				if !down, implied {
					self.shifted.remove(key)
					try self.keyEvent(shiftCode, down: false, flags: self.flags)
				}
			}
		}
	}

	func type(_ text: String) async throws {
		// Newlines and tabs as their keys; the rest as key events carrying their characters.
		var pieces: [String] = []
		var run = ""
		for c in text {
			if c == "\n" || c == "\t" {
				if !run.isEmpty { pieces.append(run) }
				pieces.append(String(c))
				run = ""
			} else {
				run.append(c)
			}
		}
		if !run.isEmpty { pieces.append(run) }
		let flags = held
		try await InputQueue.run {
			for piece in pieces {
				try InputQueue.checkCancelled()
				if piece == "\n" || piece == "\t" {
					let code = Keycodes.named[piece == "\n" ? "enter" : "tab"]!
					try self.keyEvent(code, down: true, flags: flags)
					try self.keyEvent(code, down: false, flags: flags)
					InputQueue.pause(5)
					continue
				}
				try Gestures.text(Keycodes.textEvents(piece, source: nil)) {
					$0.flags = flags
					$0.post(tap: .cghidEventTap)
				}
			}
		}
	}
}
#endif
