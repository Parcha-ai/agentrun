#if os(macOS)
import AppKit
import ApplicationServices
import ComputerdKit
import CoreGraphics
import Foundation

/// Input runs one batch at a time on its own thread: the recipes sleep between events, and two clicks interleaved
/// would be one garbled gesture.
enum InputQueue {
	static let queue = DispatchQueue(label: "ai.parcha.computerd.input")

	/// Runs a body on the input thread. A cancelled request stops it between events: a loop calls checkCancelled()
	/// before each event, so a long scroll or text never keeps posting after its request is cancelled or its
	/// connection is gone, and never holds up the requests queued behind it.
	static func run(_ body: @escaping @Sendable () throws -> Void) async throws {
		let flag = InputCancel()
		try await withTaskCancellationHandler {
			try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
				queue.async {
					active.set(flag)
					defer { active.set(nil) }
					do {
						try checkCancelled()
						try body()
						done.resume()
					} catch {
						done.resume(throwing: error)
					}
				}
			}
		} onCancel: {
			flag.cancel()
		}
	}

	private static let active = ActiveCancel()

	/// Throws when the request whose body is running was cancelled.
	static func checkCancelled() throws {
		if active.get()?.isCancelled == true { throw CancellationError() }
	}

	static func pause(_ ms: Double) {
		if ms > 0 { Thread.sleep(forTimeInterval: ms / 1000) }
	}
}

/// Whether the request whose body runs on the input thread was cancelled.
final class InputCancel: @unchecked Sendable {
	private let lock = NSLock()
	private var cancelled = false
	func cancel() { lock.withLock { cancelled = true } }
	var isCancelled: Bool { lock.withLock { cancelled } }
}

/// The InputCancel of the body running now: one at a time, as the queue runs them.
final class ActiveCancel: @unchecked Sendable {
	private let lock = NSLock()
	private var flag: InputCancel?
	func set(_ new: InputCancel?) { lock.withLock { flag = new } }
	func get() -> InputCancel? { lock.withLock { flag } }
}

/// The points a drag passes through, one event about every 16 ms over ms, along each leg in proportion to its length.
func dragPoints(_ path: [Point], ms: Int) -> [CGPoint] {
	let points = path.map { CGPoint(x: $0.x, y: $0.y) }
	guard points.count >= 2 else { return points }
	var legs: [Double] = []
	for i in 1..<points.count { legs.append(hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)) }
	let total = max(legs.reduce(0, +), 1)
	let steps = max(points.count - 1, min(500, ms / 16))
	var out = [points[0]]
	for (i, leg) in legs.enumerated() {
		let n = max(1, Int((Double(steps) * leg / total).rounded()))
		for k in 1...n {
			let t = CGFloat(k) / CGFloat(n)
			out.append(CGPoint(x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t))
		}
	}
	return out
}

/// Input posted to one app's window without bringing it to the front or moving the user's pointer: SkyLight's
/// pid-routed events, with the window stamped on each, and for keys a synthetic focus that makes the window key inside
/// its app without raising it. A route that cannot reach the window throws RouteUnavailable, so the next route tries.
struct BackgroundRoute: InputRoute {
	let sky: SkyLight

	/// The target's window id, once it is checked to be the app's and on screen.
	func window(_ t: ResolvedTarget) throws -> CGWindowID {
		guard let wid = CGWindowID(t.window.id) else { throw RouteUnavailable("window \(t.window.id) is not a window server id") }
		if NSRunningApplication(processIdentifier: t.pid)?.isHidden == true {
			throw RouteUnavailable("\(t.app.id) is hidden, and input posted to a hidden app lands nowhere")
		}
		let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]] ?? []
		guard info.contains(where: { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == t.pid }) else {
			throw RPCError.stale("window \(t.window.id) of \(t.app.id) is gone: observe again")
		}
		return wid
	}

	/// The target's window id, for input at a screen point: refused when another app's window is over the point, since
	/// the click would land on that window (on a Mac mini, a Finder window under Computerd's own and Notes' sheet took
	/// 24 s of clicks that renamed nothing). The foreground route raises the window first, so it is the way on.
	func window(_ t: ResolvedTarget, at point: CGPoint) throws -> CGWindowID {
		let wid = try window(t)
		if let cover = Self.cover(at: point, over: wid, pid: t.pid) {
			throw RouteUnavailable("window \(t.window.id) of \(t.app.id) is covered at (\(Int(point.x)), \(Int(point.y))) by \(cover)")
		}
		return wid
	}

	/// The app whose window is over the point, in front of the target's window; nil when nothing is. The app's own
	/// windows (a sheet, a popover) do not count: they are where its own click goes. Only ordinary windows (layer 0)
	/// count, so the menu bar, the Dock and transparent system overlays never refuse a click.
	static func cover(at point: CGPoint, over wid: CGWindowID, pid: pid_t) -> String? {
		func number(_ info: [String: Any], _ key: CFString) -> NSNumber? { info[key as String] as? NSNumber }
		// On-screen windows, front to back.
		let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
		for info in list {
			if number(info, kCGWindowNumber)?.uint32Value == wid { return nil }
			if number(info, kCGWindowOwnerPID)?.int32Value == pid { continue }
			if number(info, kCGWindowLayer)?.intValue != 0 { continue }
			if (number(info, kCGWindowAlpha)?.doubleValue ?? 1) == 0 { continue }
			guard let dict = info[kCGWindowBounds as String] as? NSDictionary,
				let rect = CGRect(dictionaryRepresentation: dict as CFDictionary), rect.contains(point)
			else { continue }
			return (info[kCGWindowOwnerName as String] as? String).map { "\($0)'s window" } ?? "another app's window"
		}
		return nil
	}

	/// Runs body with the app thinking it is active and, for keys, the window key inside it; nothing is raised. An app
	/// already in front is active, but its key window may be another of its own: keys still make this one key first.
	/// After keys the app keeps the focus it was given. Taking it away right after them raced their handling (TextEdit
	/// dropped a super+a about one time in fifteen on the mini) and ended an edit they began: Finder's rename field
	/// closed before the new name was typed. After a click the focus is taken back.
	static func withFocus(_ sky: SkyLight, _ pid: pid_t, _ wid: CGWindowID, key: Bool, settleMs: Double, _ body: () throws -> Void) throws {
		if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
			if key {
				try sky.makeKey(try sky.psn(pid), window: wid)
				InputQueue.pause(10)
			}
			try body()
			return
		}
		let psn = try sky.psn(pid)
		try sky.activate(psn, window: wid, focused: true)
		do {
			if key {
				try sky.makeKey(psn, window: wid)
				InputQueue.pause(10)
			}
			try body()
			InputQueue.pause(settleMs)
		} catch {
			try? sky.activate(psn, window: wid, focused: false)
			throw error
		}
		if !key { try sky.activate(psn, window: wid, focused: false) }
	}

	/// The fields that tell the window server which process and window a mouse event is for.
	static func stamp(_ sky: SkyLight, _ e: CGEvent, pid: pid_t, wid: CGWindowID) {
		sky.set(e, EventField.targetPID, Int64(pid))
		sky.set(e, EventField.windowNumber, Int64(wid))
		sky.set(e, EventField.windowUnderPointer, Int64(wid))
		sky.set(e, EventField.handlingWindowUnderPointer, Int64(wid))
	}

	/// Where the window server reads a pid-routed event's point: in the window on macOS 27 and later, on the screen
	/// before.
	static func location(_ screen: CGPoint, _ t: ResolvedTarget) -> CGPoint {
		macOSMajor >= 27 ? CGPoint(x: screen.x - t.window.bounds.x, y: screen.y - t.window.bounds.y) : screen
	}

	struct MouseStep {
		var type: CGEventType
		var atTarget: Bool
		var clickState: Int64
		var phase: Int64
		var pauseMs: Double
	}

	/// A move, a primer press off screen, then count presses at the point, as each count's click state.
	static func clickRecipe(_ button: MouseButton, count: Int) -> [MouseStep] {
		let (down, up): (CGEventType, CGEventType) = button == .left ? (.leftMouseDown, .leftMouseUp) : (.rightMouseDown, .rightMouseUp)
		var steps = [
			MouseStep(type: .mouseMoved, atTarget: true, clickState: 0, phase: 2, pauseMs: 15),
			MouseStep(type: down, atTarget: false, clickState: 1, phase: 1, pauseMs: 1),
			MouseStep(type: up, atTarget: false, clickState: 1, phase: 2, pauseMs: 100),
		]
		for i in 1...max(1, count) {
			steps.append(MouseStep(type: down, atTarget: true, clickState: Int64(i), phase: 3, pauseMs: 1))
			steps.append(MouseStep(type: up, atTarget: true, clickState: Int64(i), phase: 3, pauseMs: i < count ? 80 : 0))
		}
		return steps
	}

	func click(at point: Point, button: MouseButton, count: Int, in t: ResolvedTarget) async throws {
		let screen = CGPoint(x: point.x, y: point.y)
		let wid = try window(t, at: screen)
		let sky = self.sky
		let pid = t.pid
		let stamped = Self.location(screen, t)
		let primer = CGPoint(x: -1, y: -1)
		try await InputQueue.run {
			guard let source = CGEventSource(stateID: .hidSystemState) else { throw RouteUnavailable("the system made no event source") }
			let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
			let cgButton: CGMouseButton = button == .left ? .left : .right
			try Self.withFocus(sky, pid, wid, key: false, settleMs: 100) {
				for step in Self.clickRecipe(button, count: count) {
					guard let e = CGEvent(mouseEventSource: source, mouseType: step.type, mouseCursorPosition: step.atTarget ? screen : primer, mouseButton: cgButton) else {
						throw RouteUnavailable("the system made no mouse event")
					}
					sky.set(e, EventField.gesturePhase, step.phase)
					sky.set(e, EventField.clickState, step.clickState)
					sky.set(e, EventField.buttonNumber, button == .left ? 0 : 1)
					sky.set(e, EventField.subtype, 3)
					sky.set(e, EventField.clickGroup, group)
					Self.stamp(sky, e, pid: pid, wid: wid)
					sky.setWindowLocation(e, step.atTarget ? stamped : primer)
					// One path only: an AppKit window takes both, so posting on both clicked twice (the ui fixture's canvas
					// counted 2 per click on macos-26). SkyLight's also reaches Chromium; the public one is for a macOS
					// without it.
					if !sky.post(e, to: pid) { e.postToPid(pid) }
					InputQueue.pause(step.pauseMs)
				}
			}
		}
	}

	func scroll(at point: Point, dx: Double, dy: Double, in t: ResolvedTarget) async throws {
		let screen = CGPoint(x: point.x, y: point.y)
		let wid = try window(t, at: screen)
		let sky = self.sky
		let pid = t.pid
		try await InputQueue.run {
			// In pieces of at most 100 points, as a wheel sends them; dy > 0 shows what is below.
			var (left, down) = (dx, dy)
			while left != 0 || down != 0 {
				try InputQueue.checkCancelled()
				let sx = max(-100, min(100, left))
				let sy = max(-100, min(100, down))
				guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-sy), wheel2: Int32(-sx), wheel3: 0) else {
					throw RouteUnavailable("the system made no scroll event")
				}
				e.location = screen
				Self.stamp(sky, e, pid: pid, wid: wid)
				e.postToPid(pid)
				left -= sx
				down -= sy
				InputQueue.pause(10)
			}
		}
	}

	func drag(_ path: [Point], ms: Int, in t: ResolvedTarget) async throws {
		let points = dragPoints(path, ms: ms)
		guard let start = points.first, let end = points.last else { throw RouteUnavailable("a drag needs a path") }
		_ = try window(t, at: end)
		let wid = try window(t, at: start)
		let pid = t.pid
		let sky = self.sky
		let pauseMs = Double(ms) / Double(max(1, points.count - 1))
		try await InputQueue.run {
			guard let source = CGEventSource(stateID: .combinedSessionState) else { throw RouteUnavailable("the system made no event source") }
			try Self.withFocus(sky, pid, wid, key: false, settleMs: 50) {
				func post(_ type: CGEventType, _ at: CGPoint) throws {
					guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left) else {
						throw RouteUnavailable("the system made no mouse event")
					}
					e.setIntegerValueField(.mouseEventClickState, value: 1)
					Self.stamp(sky, e, pid: pid, wid: wid)
					e.postToPid(pid)
				}
				try post(.mouseMoved, points[0])
				try post(.leftMouseDown, points[0])
				// The release goes out even when a move fails, so the app is never left holding the button.
				defer { try? post(.leftMouseUp, points[points.count - 1]) }
				for p in points.dropFirst() {
					try InputQueue.checkCancelled()
					InputQueue.pause(pauseMs)
					try post(.leftMouseDragged, p)
				}
			}
		}
	}

	func type(_ text: String, in t: ResolvedTarget) async throws {
		let wid = try window(t)
		let sky = self.sky
		let pid = t.pid
		try await InputQueue.run {
			let events = try Keycodes.textEvents(text, source: nil)
			try Self.withFocus(sky, pid, wid, key: true, settleMs: 10) {
				for (i, e) in events.enumerated() {
					try InputQueue.checkCancelled()
					e.postToPid(pid)
					if i % 2 == 1 { InputQueue.pause(5) }
				}
			}
		}
	}

	func key(_ chord: KeyChord, in t: ResolvedTarget) async throws {
		let wid = try window(t)
		let sky = self.sky
		let pid = t.pid
		try await InputQueue.run {
			let events = try Keycodes.events(chord, source: nil)
			try Self.withFocus(sky, pid, wid, key: true, settleMs: 10) {
				for e in events {
					e.postToPid(pid)
					InputQueue.pause(2)
				}
			}
		}
	}
}

/// Input as the keyboard and mouse: the app comes to the front, its window is raised, and the user's pointer moves.
/// Taken only when a call allows it (foreground: true).
struct ForegroundRoute: InputRoute {
	let accessibility: MacAccessibility

	/// Brings the target's app to the front and, with the tree, raises its window, so what the keyboard and mouse do
	/// lands there. Without the tree the app comes forward with its own front window.
	func front(_ t: ResolvedTarget) throws {
		guard let app = NSRunningApplication(processIdentifier: t.pid) else { throw RPCError.stale("\(t.app.id) is no longer running") }
		if NSWorkspace.shared.frontmostApplication?.processIdentifier != t.pid {
			if app.isHidden { app.unhide() }
			app.activate()
		}
		if accessibility.feature.isOn {
			_ = AXUIElementPerformAction(try accessibility.window(t), kAXRaiseAction as CFString)
		}
		for _ in 0..<20 where NSWorkspace.shared.frontmostApplication?.processIdentifier != t.pid {
			InputQueue.pause(25)
		}
		guard NSWorkspace.shared.frontmostApplication?.processIdentifier == t.pid else {
			throw RouteUnavailable("\(t.app.id) did not come to the front")
		}
	}

	static func post(_ type: CGEventType, _ at: CGPoint, button: CGMouseButton = .left, clickState: Int64 = 1) throws {
		guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: button) else {
			throw RouteUnavailable("the system made no mouse event")
		}
		e.setIntegerValueField(.mouseEventClickState, value: clickState)
		e.post(tap: .cghidEventTap)
	}

	func click(at point: Point, button: MouseButton, count: Int, in t: ResolvedTarget) async throws {
		let at = CGPoint(x: point.x, y: point.y)
		try await InputQueue.run {
			try self.front(t)
			let (down, up): (CGEventType, CGEventType) = button == .left ? (.leftMouseDown, .leftMouseUp) : (.rightMouseDown, .rightMouseUp)
			let cgButton: CGMouseButton = button == .left ? .left : .right
			try Self.post(.mouseMoved, at)
			InputQueue.pause(15)
			for i in 1...max(1, count) {
				try Self.post(down, at, button: cgButton, clickState: Int64(i))
				InputQueue.pause(1)
				try Self.post(up, at, button: cgButton, clickState: Int64(i))
				if i < count { InputQueue.pause(80) }
			}
		}
	}

	func scroll(at point: Point, dx: Double, dy: Double, in t: ResolvedTarget) async throws {
		let at = CGPoint(x: point.x, y: point.y)
		try await InputQueue.run {
			try self.front(t)
			try Self.post(.mouseMoved, at)
			var (left, down) = (dx, dy)
			while left != 0 || down != 0 {
				try InputQueue.checkCancelled()
				let sx = max(-100, min(100, left))
				let sy = max(-100, min(100, down))
				guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-sy), wheel2: Int32(-sx), wheel3: 0) else {
					throw RouteUnavailable("the system made no scroll event")
				}
				e.location = at
				e.post(tap: .cghidEventTap)
				left -= sx
				down -= sy
				InputQueue.pause(10)
			}
		}
	}

	func drag(_ path: [Point], ms: Int, in t: ResolvedTarget) async throws {
		let points = dragPoints(path, ms: ms)
		let pauseMs = Double(ms) / Double(max(1, points.count - 1))
		try await InputQueue.run {
			try self.front(t)
			try Self.post(.mouseMoved, points[0])
			try Self.post(.leftMouseDown, points[0])
			defer { try? Self.post(.leftMouseUp, points[points.count - 1]) }
			for p in points.dropFirst() {
				try InputQueue.checkCancelled()
				InputQueue.pause(pauseMs)
				try Self.post(.leftMouseDragged, p)
			}
		}
	}

	func type(_ text: String, in t: ResolvedTarget) async throws {
		try await InputQueue.run {
			try self.front(t)
			for (i, e) in try Keycodes.textEvents(text, source: nil).enumerated() {
				try InputQueue.checkCancelled()
				e.post(tap: .cghidEventTap)
				if i % 2 == 1 { InputQueue.pause(5) }
			}
		}
	}

	func key(_ chord: KeyChord, in t: ResolvedTarget) async throws {
		try await InputQueue.run {
			try self.front(t)
			for e in try Keycodes.events(chord, source: nil) {
				e.post(tap: .cghidEventTap)
				InputQueue.pause(2)
			}
		}
	}
}
#endif
