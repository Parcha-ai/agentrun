import Foundation

/// A person took the computer back while Computerd drove its own keyboard and mouse: input.actions stops before its next
/// action, and a ui act before its next step, and sends it nothing (aborted).
struct TakenOver: Error {
	let message: String
}

/// The one take-over rule, for input.actions and a ui act's foreground route alike: a person who pressed a key or a
/// mouse button, turned the wheel or moved the pointer since the call began, or whose pointer is no longer where
/// Computerd last left it, has the computer. The platform's PersonInput leaves out every event Computerd posts, so the
/// call's own keys and moves never count.
struct TakeOverWatch {
	/// How far, in pixels, the pointer may sit from where Computerd left it before a person is taken to have moved it.
	static let pixels = 3.0

	/// The call, in the words: "act" or "batch"; and what the check comes before: "step" or "action".
	let call: String
	let unit: String
	/// When the call began, on the platform's Clock.
	let since: Double
	/// Where the pointer was when the call began, or where Computerd's own input last left it, in pixels.
	var pointer: Point?

	init(call: String, unit: String, platform: Platform) {
		self.call = call
		self.unit = unit
		since = platform.clock.now()
		pointer = platform.capture.cursor()
	}

	/// Throws TakenOver when a person has the computer.
	func check(_ platform: Platform) throws {
		let stopped = "the person has the computer, so the \(call) stopped before this \(unit) and sent it nothing; observe and try again"
		if let used = platform.person.lastInput(), used > since {
			throw TakenOver(message: "someone used the keyboard or the mouse while this \(call) ran (\(Int(platform.clock.now() - used)) ms ago): \(stopped)")
		}
		let limit = Self.pixels
		if let left = pointer, let now = platform.capture.cursor(), abs(now.x - left.x) > limit || abs(now.y - left.y) > limit {
			throw TakenOver(message: "someone moved the pointer to (\(Int(now.x)), \(Int(now.y))) while this \(call) ran (it was at (\(Int(left.x)), \(Int(left.y)))): \(stopped)")
		}
	}
}
