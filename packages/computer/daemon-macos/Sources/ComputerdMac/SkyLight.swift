#if os(macOS)
import AppKit
import ApplicationServices
import ComputerdKit
import CoreGraphics
import Darwin
import Foundation

/// SkyLight's private input calls and the one private accessibility call, found at run time with dlsym. A missing
/// symbol turns its route off with the symbol's name in the reason; nothing is ever called through a guess.
///
/// The event fields, the record layouts and the click recipe come from Cua Driver and open-computer-use (both MIT, see
/// NOTICE), which recovered them from yabai and with lldb. Every undocumented ABI Computerd uses is in this file, so a
/// macOS release that moves one has one place to look.
final class SkyLight: @unchecked Sendable {
	static let shared = SkyLight()

	typealias PostToPid = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
	typealias SetIntegerField = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
	/// (event, x, y): the scalar form, so nothing leans on how Swift passes a CGPoint to C.
	typealias SetWindowLocation = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
	typealias PostEventRecord = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
	typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32
	typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

	static let skyLightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
	static let applicationServicesPath = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"

	let postToPidFn: PostToPid?
	let setIntegerFieldFn: SetIntegerField?
	let setWindowLocationFn: SetWindowLocation?
	let postEventRecordFn: PostEventRecord?
	let getProcessForPIDFn: GetProcessForPID?
	let getWindowFn: GetWindow?
	/// The input symbols this macOS lacks.
	let missing: [String]

	init() {
		let sky = dlopen(Self.skyLightPath, RTLD_LAZY | RTLD_GLOBAL)
		let services = dlopen(Self.applicationServicesPath, RTLD_LAZY | RTLD_GLOBAL)
		var missing: [String] = []
		func find<T>(_ handle: UnsafeMutableRawPointer?, _ symbol: String, input: Bool = true) -> T? {
			guard let handle, let pointer = dlsym(handle, symbol) else {
				if input { missing.append(symbol) }
				return nil
			}
			return unsafeBitCast(pointer, to: T.self)
		}
		postToPidFn = find(sky, "SLEventPostToPid")
		setIntegerFieldFn = find(sky, "SLEventSetIntegerValueField")
		setWindowLocationFn = find(sky, "CGEventSetWindowLocation")
		postEventRecordFn = find(sky, "SLPSPostEventRecordTo")
		getProcessForPIDFn = find(services, "GetProcessForPID")
		getWindowFn = find(services, "_AXUIElementGetWindow", input: false)
		self.missing = missing
	}

	/// The background route works here, or which symbols it lacks.
	var feature: Feature {
		if missing.isEmpty { return .on }
		let names = missing.joined(separator: ", ")
		return .off("SkyLight lacks \(names) on macOS \(macOSVersion), so Computerd cannot post input to a window in the background")
	}

	/// The window server's id for an accessibility window.
	func windowID(_ element: AXUIElement) -> CGWindowID? {
		guard let getWindowFn else { return nil }
		var id: CGWindowID = 0
		guard getWindowFn(element, &id) == .success, id != 0 else { return nil }
		return id
	}

	// MARK: events

	static func pointer(_ event: CGEvent) -> UnsafeMutableRawPointer {
		Unmanaged.passUnretained(event).toOpaque()
	}

	func set(_ event: CGEvent, _ field: UInt32, _ value: Int64) {
		setIntegerFieldFn?(Self.pointer(event), field, value)
	}

	func setWindowLocation(_ event: CGEvent, _ point: CGPoint) {
		setWindowLocationFn?(Self.pointer(event), Double(point.x), Double(point.y))
	}

	/// Posts through SkyLight's path to one process, which reaches AppKit, Catalyst and Chromium windows alike. False
	/// when this macOS has no SLEventPostToPid.
	@discardableResult
	func post(_ event: CGEvent, to pid: pid_t) -> Bool {
		guard let postToPidFn else { return false }
		postToPidFn(pid, Self.pointer(event))
		return true
	}

	// MARK: synthetic focus

	/// The process serial number of a pid: 8 bytes.
	func psn(_ pid: pid_t) throws -> [UInt8] {
		guard let getProcessForPIDFn else { throw RouteUnavailable("GetProcessForPID is missing") }
		var psn = [UInt8](repeating: 0, count: 8)
		let status = psn.withUnsafeMutableBytes { getProcessForPIDFn(pid, $0.baseAddress) }
		guard status == 0 else { throw RouteUnavailable("process \(pid) has no process serial number (OSStatus \(status))") }
		return psn
	}

	func postRecord(_ record: [UInt8], to psn: [UInt8]) throws {
		guard let postEventRecordFn else { throw RouteUnavailable("SLPSPostEventRecordTo is missing") }
		let status = psn.withUnsafeBytes { p in record.withUnsafeBufferPointer { r in postEventRecordFn(p.baseAddress, r.baseAddress) } }
		guard status == 0 else { throw RouteUnavailable("the window server refused a focus record (OSStatus \(status))") }
	}

	/// Makes the app think it is active, without bringing it to the front or raising its window (focused: true), or ends
	/// that (focused: false).
	func activate(_ psn: [UInt8], window: CGWindowID, focused: Bool) throws {
		try postRecord(Self.activationRecord(window: window, focused: focused), to: psn)
		Thread.sleep(forTimeInterval: 0.010)
	}

	/// Makes the window the app's key window inside the app, without a raise: what Chromium's page focus keys off.
	func makeKey(_ psn: [UInt8], window: CGWindowID) throws {
		for record in Self.keyWindowRecords(window: window) { try postRecord(record, to: psn) }
	}

	static func activationRecord(window: CGWindowID, focused: Bool) -> [UInt8] {
		var record = [UInt8](repeating: 0, count: 0xF8)
		record[0x04] = 0xF8
		record[0x08] = 0x0D
		stampWindow(&record, window)
		record[0x8A] = focused ? 0x01 : 0x02
		return record
	}

	static func keyWindowRecords(window: CGWindowID) -> [[UInt8]] {
		var record = [UInt8](repeating: 0, count: 0xF8)
		record[0x04] = 0xF8
		record[0x3A] = 0x10
		stampWindow(&record, window)
		for i in 0x20..<0x30 { record[i] = 0xFF }
		return [UInt8(0x01), 0x02].map { kind in
			var copy = record
			copy[0x08] = kind
			return copy
		}
	}

	static func stampWindow(_ record: inout [UInt8], _ window: CGWindowID) {
		record[0x3C] = UInt8(truncatingIfNeeded: window)
		record[0x3D] = UInt8(truncatingIfNeeded: window >> 8)
		record[0x3E] = UInt8(truncatingIfNeeded: window >> 16)
		record[0x3F] = UInt8(truncatingIfNeeded: window >> 24)
	}
}

/// The event fields the click recipe stamps.
enum EventField {
	static let gesturePhase: UInt32 = 0
	static let clickState: UInt32 = 1
	static let buttonNumber: UInt32 = 3
	static let subtype: UInt32 = 7
	static let targetPID: UInt32 = 40
	static let windowNumber: UInt32 = 51
	static let clickGroup: UInt32 = 58
	static let windowUnderPointer: UInt32 = 91
	static let handlingWindowUnderPointer: UInt32 = 92
}

var macOSVersion: String {
	let v = ProcessInfo.processInfo.operatingSystemVersion
	return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

var macOSMajor: Int { ProcessInfo.processInfo.operatingSystemVersion.majorVersion }
#endif
