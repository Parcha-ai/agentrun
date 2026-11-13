#if os(macOS)
import AppKit
import ComputerdKit
import Foundation

/// A person's own keys and pointer: a global event monitor on the main thread, which sees the events that go to other
/// apps, keeping the time of the last one whose source is not Computerd. The system's idle counters can't tell them
/// apart: on the mini the HID state counted Computerd's own posted keys, from a private event source too. Key presses
/// reach a global monitor only with the Accessibility grant, which the ui routes need anyway.
final class PersonWatch: PersonInput, @unchecked Sendable {
	static let shared = PersonWatch()

	private let lock = NSLock()
	private var last: Double?
	private var monitor: Any?
	private let clock = SystemClock()

	private init() {
		let me = Int64(getpid())
		DispatchQueue.main.async { [self] in
			let kinds: NSEvent.EventTypeMask = [
				.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
				.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
			]
			let made = NSEvent.addGlobalMonitorForEvents(matching: kinds) { [self] event in
				// Events Computerd posts carry its pid as their source (on the mini, every one of its keys did).
				if event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == me { return }
				let now = clock.now()
				lock.withLock { last = now }
			}
			lock.withLock { monitor = made }
		}
	}

	func lastInput() -> Double? { lock.withLock { last } }
}
#endif
