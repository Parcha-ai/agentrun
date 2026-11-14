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

	/// An app's observer, and when its process started: a later process given the same pid is another app. No observer
	/// for an app that took none: it settles on two looks.
	struct Watch {
		let observer: AXObserver?
		let started: Double
	}

	private let lock = NSLock()
	private var watches: [pid_t: Watch] = [:]
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
		let started = Self.started(pid)
		if let known = watches[pid], known.started == started { return known.observer != nil }
		forgetGone()
		guard let started else { return false }
		var made: AXObserver?
		let callback: AXObserverCallback = { _, _, notification, refcon in
			AXChanges.shared.record(pid_t(Int(bitPattern: refcon)), notification as String)
		}
		guard AXObserverCreate(pid, callback, &made) == .success, let observer = made else {
			watches[pid] = Watch(observer: nil, started: started)
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
			if !busy { watches[pid] = Watch(observer: nil, started: started) }
			log("accessibility notifications: pid \(pid) \(busy ? "did not answer in time" : "took none of them"): a step there settles on two looks")
			return false
		}
		CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
		CFRunLoopWakeUp(runLoop)
		watches[pid] = Watch(observer: observer, started: started)
		last[pid] = nil
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

	/// Drops the watches of apps that quit, and of pids a later process now has. Called under the lock.
	private func forgetGone() {
		for (pid, watch) in watches where Self.started(pid) != watch.started {
			if let observer = watch.observer { CFRunLoopRemoveSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode) }
			watches[pid] = nil
			last[pid] = nil
		}
	}

	/// When the pid's process started, in seconds since 1970; nil when no process has it.
	static func started(_ pid: pid_t) -> Double? {
		var info = kinfo_proc()
		var size = MemoryLayout<kinfo_proc>.stride
		var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
		guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
		let start = info.kp_proc.p_un.__p_starttime
		return Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
	}
}
#endif
