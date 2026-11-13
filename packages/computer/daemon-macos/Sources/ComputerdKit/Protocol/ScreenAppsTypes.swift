import Foundation

/// [x, y]. In screen.* it is pixels of the full screenshot; in ui.* it is points of the state's window, origin at its
/// top left.
public struct Point: Sendable, Codable, Equatable, Hashable {
	public var x: Double
	public var y: Double

	public init(_ x: Double, _ y: Double) {
		self.x = x
		self.y = y
	}

	public init(from decoder: Decoder) throws {
		var c = try decoder.unkeyedContainer()
		x = try c.decode(Double.self)
		y = try c.decode(Double.self)
		guard c.isAtEnd else { throw decoder.corrupted("a point is [x, y]") }
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.unkeyedContainer()
		try c.encode(x)
		try c.encode(y)
	}
}

/// [x, y, w, h], in the same space as Point.
public struct Rect: Sendable, Codable, Equatable, Hashable {
	public var x: Double
	public var y: Double
	public var w: Double
	public var h: Double

	public init(_ x: Double, _ y: Double, _ w: Double, _ h: Double) {
		self.x = x
		self.y = y
		self.w = w
		self.h = h
	}

	public init(from decoder: Decoder) throws {
		var c = try decoder.unkeyedContainer()
		x = try c.decode(Double.self)
		y = try c.decode(Double.self)
		w = try c.decode(Double.self)
		h = try c.decode(Double.self)
		guard c.isAtEnd else { throw decoder.corrupted("a rect is [x, y, w, h]") }
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.unkeyedContainer()
		try c.encode(x)
		try c.encode(y)
		try c.encode(w)
		try c.encode(h)
	}

	public var center: Point { Point(x + w / 2, y + h / 2) }

	public func contains(_ p: Point) -> Bool {
		p.x >= x && p.y >= y && p.x < x + w && p.y < y + h
	}

	public var area: Double { max(0, w) * max(0, h) }

	/// This rect moved by (dx, dy).
	public func offset(_ dx: Double, _ dy: Double) -> Rect { Rect(x + dx, y + dy, w, h) }
}

public struct ScreenShotParams: Sendable, Codable, Equatable {
	public var region: Rect?
}

/// One image held for chunked reading: its first chunk inline, the rest through screen.read by id.
public struct ScreenShotResult: Sendable, Codable, Equatable {
	public var id: String
	public var size: Int
	public var data: Data
	public var eof: Bool
	public var width: Int
	public var height: Int
	public var scale: Double
	public var cursor: Point?
}

public struct ScreenReadParams: Sendable, Codable, Equatable {
	public var id: String
	public var offset: Int
}

public struct ScreenReadResult: Sendable, Codable, Equatable {
	public var data: Data
	public var eof: Bool
}

public struct ScreenWatchParams: Sendable, Codable, Equatable {
	public var after: Int
	public var waitMs: Int?
	public var maxWidth: Int?
	public var quality: Int?
}

public struct ScreenWatchResult: Sendable, Codable, Equatable {
	public var seq: Int
	public var changed: Bool
	public var id: String?
	public var size: Int?
	public var data: Data?
	public var eof: Bool?
	public var format: String?
	public var frameWidth: Int?
	public var frameHeight: Int?
	public var width: Int
	public var height: Int
	public var cursor: Point?
}

public struct App: Sendable, Codable, Equatable {
	public var id: String
	public var name: String?
	public var version: String?

	public init(id: String, name: String? = nil, version: String? = nil) {
		self.id = id
		self.name = name
		self.version = version
	}
}

public struct AppsListResult: Sendable, Codable, Equatable {
	public var apps: [App]
	/// The app in front; on the wire null when none, never left out.
	public var foreground: String?

	public init(apps: [App], foreground: String?) {
		self.apps = apps
		self.foreground = foreground
	}

	enum CodingKeys: String, CodingKey { case apps, foreground }

	public func encode(to encoder: Encoder) throws {
		var c = encoder.container(keyedBy: CodingKeys.self)
		try c.encode(apps, forKey: .apps)
		try c.encode(foreground, forKey: .foreground)
	}
}

public struct AppsLaunchParams: Sendable, Codable, Equatable {
	/// A bundle id: "com.apple.Notes".
	public var id: String
	/// Open this in the app: a deep link, or a page in a browser.
	public var url: String?
	/// Open it without bringing it to the front (feature apps.background).
	public var background: Bool?

	public init(id: String, url: String? = nil, background: Bool? = nil) {
		self.id = id
		self.url = url
		self.background = background
	}
}

public struct AppsTerminateParams: Sendable, Codable, Equatable {
	public var id: String

	public init(id: String) {
		self.id = id
	}
}
