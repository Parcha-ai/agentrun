/// What a computer offers, as hello.groups lists them.
public enum Group: String, Sendable, Codable, CaseIterable {
	case exec, files, processes, screen
	case inputPointer = "input.pointer"
	case inputKeys = "input.keys"
	case inputTouch = "input.touch"
	case apps
	case appsInstall = "apps.install"
	case ui
}

/// One feature of a computer: on, or off with the reason in words a person can act on.
/// On the wire: `true`, or `{"off": "Screen Recording is not granted to Computerd"}`.
public enum Feature: Sendable, Equatable, Codable {
	case on
	case off(String)

	public init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if let flag = try? c.decode(Bool.self) {
			guard flag else { throw decoder.corrupted("a feature is true or {off: reason}") }
			self = .on
			return
		}
		self = .off(try c.decode(Off.self).off)
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.singleValueContainer()
		switch self {
		case .on: try c.encode(true)
		case .off(let reason): try c.encode(Off(off: reason))
		}
	}

	struct Off: Codable { var off: String }

	public var isOn: Bool { self == .on }

	/// on when every one is on; else the first one's reason.
	public static func all(_ features: Feature...) -> Feature {
		for f in features { if case .off = f { return f } }
		return .on
	}
}

/// The names hello.features uses (protocol.json features). Each is a route or a sense the driver may lack, with why.
public enum FeatureName {
	/// apps.launch with background: true opens an app without bringing it to the front.
	public static let appsBackground = "apps.background"
	/// ui.observe reads the window's elements; off, it answers the window's image with no nodes, or is refused.
	public static let tree = "ui.tree"
	/// ui.observe returns the window's image.
	public static let image = "ui.image"
	/// Input posted to one app's window without bringing it to the front.
	public static let background = "ui.background"
	/// Input as if from the keyboard and mouse, which moves the user's pointer (only when a call allows it).
	public static let foreground = "ui.foreground"
	/// Web pages through the browser's own protocol.
	public static let page = "ui.page"
	/// The nav step: back, home and app_switch.
	public static let nav = "ui.nav"

	public static let all = [appsBackground, tree, image, background, foreground, page, nav]
}

/// What the machine is, the same fields on every OS: "Apple", "MacBook Pro".
public struct Device: Sendable, Codable, Equatable {
	public var maker: String
	public var model: String

	public init(maker: String, model: String) {
		self.maker = maker
		self.model = model
	}
}

/// The screen in points, and how many pixels a point holds.
public struct ScreenInfo: Sendable, Codable, Equatable {
	public var width: Double
	public var height: Double
	public var scale: Double

	public init(width: Double, height: Double, scale: Double) {
		self.width = width
		self.height = height
		self.scale = scale
	}
}

public struct HelloResult: Sendable, Codable, Equatable {
	public var `protocol`: String
	public var version: String
	public var os: String
	public var osVersion: String?
	public var kind: String
	public var arch: String
	public var groups: [Group]
	public var screen: ScreenInfo?
	public var features: [String: Feature]?
	public var device: Device?

	public init(
		protocol: String = protocolVersion, version: String = driverVersion, os: String, osVersion: String?, kind: String,
		arch: String, groups: [Group], screen: ScreenInfo?, features: [String: Feature]?, device: Device?
	) {
		self.protocol = `protocol`
		self.version = version
		self.os = os
		self.osVersion = osVersion
		self.kind = kind
		self.arch = arch
		self.groups = groups
		self.screen = screen
		self.features = features
		self.device = device
	}
}

/// What a client sends with hello. The driver takes any params, so a newer client is never refused.
public struct HelloParams: Sendable, Codable, Equatable {
	/// Who is asking, for the log: a name and version.
	public var client: String

	public init(client: String) {
		self.client = client
	}
}

public struct Empty: Sendable, Codable, Equatable {
	public init() {}
}

/// Go's name for the machine this runs on, as hello.arch says it.
public var goArch: String {
	#if arch(arm64)
	return "arm64"
	#elseif arch(x86_64)
	return "amd64"
	#else
	return "unknown"
	#endif
}
