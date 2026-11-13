#if os(macOS)
import AppKit
import ComputerdKit
import Foundation

/// A person's own keys and pointer: event monitors on the main thread, a global one for the events that go to other apps
/// and a local one for those that go to Computerd's own windows, keeping the time of the last one whose source is not
/// Computerd. The system's idle counters can't tell them apart: on the mini the HID state counted Computerd's own posted
/// keys, from a private event source too. Key presses reach a global monitor only with the Accessibility grant, which the
/// ui routes need anyway.
final class PersonWatch: PersonInput, @unchecked Sendable {
	static let shared = PersonWatch(watching: true)

	/// flagsChanged: a modifier pressed on its own (Shift, Control, Option, Command, Caps Lock) is the keyboard too.
	static let kinds: NSEvent.EventTypeMask = [
		.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
		.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
	]

	private let lock = NSLock()
	private var last: Double?
	private var monitors: [Any] = []
	private let clock = SystemClock()
	private let me = Int64(getpid())

	init(watching: Bool) {
		guard watching else { return }
		DispatchQueue.main.async { [self] in
			let seen: (NSEvent) -> Void = { [self] event in
				record(source: event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID))
			}
			var made: [Any] = []
			if let global = NSEvent.addGlobalMonitorForEvents(matching: Self.kinds, handler: seen) { made.append(global) }
			if let local = NSEvent.addLocalMonitorForEvents(matching: Self.kinds, handler: { event in
				seen(event)
				return event
			}) { made.append(local) }
			lock.withLock { monitors = made }
		}
	}

	/// One event, from the process `source`. Events Computerd posts carry its pid as their source (on the mini, every one
	/// of its keys did) and are not a person's. The time kept is when the monitor saw it, not the event's timestamp:
	/// posted events (a remote screen's, a test's) can carry 0 there, which would date them before any act. A key
	/// pressed just before an act began and seen just after stops that act: someone is at the keyboard.
	func record(source: Int64?) {
		if source == me { return }
		let now = clock.now()
		lock.withLock { last = now }
	}

	func lastInput() -> Double? { lock.withLock { last } }
}
#endif
