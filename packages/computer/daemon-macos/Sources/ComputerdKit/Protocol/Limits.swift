/// The protocol's version and limits, as spec/computer/protocol.json publishes them. A test reads protocol.json and
/// holds these equal to it.
public enum Limits {
	public static let maxLineBytes = 1024 * 1024
	public static let maxOutputBytes = 360 * 1024
	public static let maxChunkBytes = 512 * 1024
	public static let maxListDepth = 16
	public static let maxListEntries = 1000
	public static let maxActions = 100
	public static let maxBatchWaitMs = 300_000
	public static let maxKeyRepeat = 100
	public static let maxUiNodes = 5000
	public static let maxSteps = 100
	public static let maxExpectMs = 60_000
	public static let defaultExpectMs = 5000
	public static let maxSettleMs = 3000
	/// How long after its first settle the act reads its final view again when a step set a value: an app that took
	/// the value back by then did not keep it, so the set is not verified.
	public static let setHoldMs = 500
	public static let minImageEdge = 256
	public static let maxImageEdge = 2048
	public static let defaultImageEdge = 1568
}

/// The protocol version this driver speaks, apart from its own version.
public let protocolVersion = "0.2"

/// The driver's own version: the package's, stamped by the build.
public let driverVersion = "0.2.0-dev"
