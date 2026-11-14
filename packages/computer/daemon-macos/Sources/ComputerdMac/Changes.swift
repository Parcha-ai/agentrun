#if os(macOS)
import ApplicationServices
import ComputerdKit
import Darwin
import Foundation

/// When each app's accessibility tree last changed, as the app tells it: one AXObserver per app, registered on the app's
/// element (which tells the changes of every element in it), its source on a run loop of its own thread. The engine
/// settles on these instead of reading a window again and again (Changes). Shared by every connection: an app's
/// observer is made the first time a connection looks at it, and dropped once the app quit.
final class AXChanges: Changes, @unchecked Sendable {
	static let shared = AXChanges()

	/// What counts as a change: what a look reads (values, titles, elements made, the focus, the selection, layout) and
	/// the window's place, size and turn as main window. Not AXUIElementDestroyed or AXRowCountChanged: apps tell those
	/// for what a read itself made (on CI, System Settings told 43 to 113 elements destroyed and 8 to 10 row counts per
	/// act, Notes, Calendar and Safari 5 to 16 row counts), so every read looked like a change and was read again. Nor
	/// AXSelectedTextChanged: a caret that moves changes nothing a look shows.
	static let notifications: [String] = [
		kAXValueChangedNotification, kAXTitleChangedNotification, kAXCreatedNotification,
		kAXFocusedUIElementChangedNotification, kAXLayoutChangedNotification, kAXSelectedChildrenChangedNotification,
		kAXSelectedRowsChangedNotification, kAXWindowCreatedNotification, kAXWindowMovedNotification,
		kAXWindowResizedNotification, kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
	]

	private let lock = NSLock()
	private var observers: [pid_t: AXObserver] = [:]
	/// Apps whose observer could not be made or took no notification: they settle on two looks.
	private var refused: Set<pid_t> = []
	private var last: [pid_t: Double] = [:]
	/// Notifications by name since the last act's trace took them (told()).
	private var counts: [String: Int] = [:]
	private let clock = SystemClock()
	private let runLoop: CFRunLoop

	private init() {
		final class Box: @unchecked Sendable { var loop: CFRunLoop? }
		let box = Box()
		let started = DispatchSemaphore(value: 0)
		let thread = Thread {
			box.loop = CFRunLoopGetCurrent()
			// A run loop with no source returns at once: a port that never fires keeps this one running.
			RunLoop.current.add(NSMachPort(), forMode: .default)
			started.signal()
			RunLoop.current.run()
		}
		thread.name = "Computerd accessibility notifications"
		thread.start()
		started.wait()
		runLoop = box.loop!
	}

	func watch(_ pid: Int32) -> Bool {
		lock.lock()
		defer { lock.unlock() }
		if observers[pid] != nil { return true }
		if refused.contains(pid) { return false }
		forgetQuit()
		var made: AXObserver?
		let callback: AXObserverCallback = { _, _, notification, refcon in
			AXChanges.shared.record(pid_t(Int(bitPattern: refcon)), notification as String)
		}
		guard AXObserverCreate(pid, callback, &made) == .success, let observer = made else {
			refused.insert(pid)
			log("accessibility notifications: no observer for pid \(pid): a step there settles on two looks")
			return false
		}
		let app = AXUIElementCreateApplication(pid)
		var taken = 0
		var busy = false
		var failed: [String] = []
		for name in Self.notifications {
			let err = AXObserverAddNotification(observer, app, name as CFString, UnsafeMutableRawPointer(bitPattern: Int(pid)))
			switch err {
			case .success, .notificationAlreadyRegistered: taken += 1
			case .cannotComplete: busy = true
			default: failed.append("\(name) (\(err.rawValue))")
			}
			// An app too busy to answer is asked again at the next look, not one notification at a time now.
			if busy { break }
		}
		guard taken > 0, !busy else {
			for name in Self.notifications { _ = AXObserverRemoveNotification(observer, app, name as CFString) }
			if !busy { refused.insert(pid) }
			log("accessibility notifications: pid \(pid) \(busy ? "did not answer in time" : "took none of them"): a step there settles on two looks")
			return false
		}
		CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
		CFRunLoopWakeUp(runLoop)
		observers[pid] = observer
		log("accessibility notifications: watching pid \(pid), \(taken) of \(Self.notifications.count)\(failed.isEmpty ? "" : "; refused \(failed.joined(separator: ", "))")")
		return true
	}

	func lastChange(_ pid: Int32) -> Double? {
		lock.withLock { last[pid] }
	}

	func record(_ pid: pid_t, _ notification: String) {
		let now = clock.now()
		lock.withLock {
			last[pid] = now
			counts[notification, default: 0] += 1
		}
	}

	/// The notifications told since the last call, by every watched app, by name, most first: for an act's trace line.
	func told() -> String {
		let taken = lock.withLock {
			defer { counts = [:] }
			return counts
		}
		guard !taken.isEmpty else { return "no changes told since the last act" }
		let names = taken.sorted { $0.value > $1.value }.map { "\($0.key.replacingOccurrences(of: "AX", with: "")) \($0.value)" }
		return "\(taken.values.reduce(0, +)) changes told since the last act (\(names.joined(separator: ", ")))"
	}

	/// Drops the observers of apps that quit. Called under the lock.
	private func forgetQuit() {
		for (pid, observer) in observers where kill(pid, 0) != 0 && errno == ESRCH {
			CFRunLoopRemoveSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
			observers[pid] = nil
			last[pid] = nil
		}
		refused = refused.filter { kill($0, 0) == 0 || errno != ESRCH }
	}
}
#endif
