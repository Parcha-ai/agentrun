import Foundation

/// Where ui.act last acted, for the live view. A step by the semantic or background route moves no real pointer, so a
/// person watching (screen.watch) would see a window change with nothing pointing at why: the engine marks each step's
/// place here, and the live view's frames draw a pointer there, a ring on a press or a click, and a box around the
/// field a step types into. Only screen.watch draws them: screen.shot and a window's image are what a model reads, and
/// stay the screen as it is.
///
/// One store a process: the connection that acts (an agent's) and the one that watches (a person's live view) are two.
public final class Marks: @unchecked Sendable {
	/// The store the app's connections share.
	public static let shared = Marks()

	/// How long the pointer stays where the last step left it, then how long it takes to fade.
	public static let pointerMs = 6000.0
	public static let fadeMs = 600.0
	/// How long a press's or a click's ring grows and fades.
	public static let ringMs = 700.0
	/// How long a typed-into field's box shows.
	public static let boxMs = 900.0

	public enum Kind: String, Sendable {
		/// A press, a click or a perform: the pointer goes there and a ring shows.
		case press
		/// Text or a key into an element: the pointer goes there and the element's box shows.
		case type
		/// A key or text with no element named, a scroll, a drag: the pointer goes there.
		case point
	}

	public struct Mark: Sendable, Equatable {
		public let at: Double
		public let point: Point
		public let kind: Kind
		public let box: Rect?
	}

	/// What a live view frame drawn at a moment shows, in screen points.
	public struct Scene: Sendable, Equatable {
		/// The pointer and its opacity, 0 to 1.
		public let pointer: Point
		public let alpha: Double
		/// A press's ring: how far it has grown, 0 to 1 (it fades as it grows).
		public let ring: Double?
		/// A typed-into element's frame, and its opacity.
		public let box: Rect?
		public let boxAlpha: Double
	}

	private let lock = NSLock()
	private var last: Mark?

	public init() {}

	/// A step's place, at a time on the engine's clock (milliseconds).
	public func mark(_ kind: Kind, at point: Point, box: Rect? = nil, now: Double) {
		lock.lock()
		defer { lock.unlock() }
		last = Mark(at: now, point: point, kind: kind, box: box)
	}

	/// The last step's place moved, its time and kind kept: an element scrolled into view after it was marked. Its box,
	/// when it had one, is the element's new frame.
	public func move(to point: Point, box: Rect?) {
		lock.lock()
		defer { lock.unlock() }
		guard let mark = last else { return }
		last = Mark(at: mark.at, point: point, kind: mark.kind, box: mark.box == nil ? nil : box)
	}

	/// The last step's place, for a step that names no place of its own (a key to the window's focus).
	public var lastPoint: Point? {
		lock.lock()
		defer { lock.unlock() }
		return last?.point
	}

	/// What a frame drawn at `now` shows; nil once the pointer has faded, or before any step.
	public func scene(now: Double) -> Scene? {
		lock.lock()
		let mark = last
		lock.unlock()
		guard let mark else { return nil }
		let age = now - mark.at
		guard age >= 0, age < Self.pointerMs + Self.fadeMs else { return nil }
		let alpha = age <= Self.pointerMs ? 1 : 1 - (age - Self.pointerMs) / Self.fadeMs
		let ring = mark.kind == .press && age < Self.ringMs ? age / Self.ringMs : nil
		let showsBox = mark.kind == .type && mark.box != nil && age < Self.boxMs
		return Scene(pointer: mark.point, alpha: alpha, ring: ring, box: showsBox ? mark.box : nil, boxAlpha: showsBox ? 1 - age / Self.boxMs : 0)
	}
}
