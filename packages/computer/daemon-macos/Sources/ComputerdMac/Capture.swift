#if os(macOS)
import ComputerdKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Window and screen images through ScreenCaptureKit. A window is captured on its own, so one covered by another still
/// shows its own pixels.
final class MacCapture: Capture, @unchecked Sendable {
	private let lock = NSLock()
	private var content: (at: Date, value: SCShareableContent)?

	init() {}

	var feature: Feature {
		CGPreflightScreenCaptureAccess()
			? .on
			: .off("Screen Recording is not granted to Computerd: allow it in System Settings > Privacy & Security > Screen & System Audio Recording")
	}

	/// What is on screen, kept a second: listing it is the slow part of a capture.
	func shareable() async throws -> SCShareableContent {
		lock.lock()
		let cached = content
		lock.unlock()
		if let cached, Date().timeIntervalSince(cached.at) < 1 { return cached.value }
		let fresh: SCShareableContent
		do {
			fresh = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
		} catch {
			throw RPCError.denied("the screen cannot be read: \(error.localizedDescription)")
		}
		lock.lock()
		content = (Date(), fresh)
		lock.unlock()
		return fresh
	}

	func scWindow(_ target: ResolvedTarget) async throws -> SCWindow {
		guard let wid = CGWindowID(target.window.id) else { throw RPCError.notFound("window \(target.window.id) is not a window server id") }
		if let found = try await shareable().windows.first(where: { $0.windowID == wid }) { return found }
		lock.lock()
		content = nil
		lock.unlock()
		guard let found = try await shareable().windows.first(where: { $0.windowID == wid }) else {
			throw RPCError.notFound("window \(target.window.id) of \(target.app.id) is not on screen")
		}
		return found
	}

	/// One frame of a window, at most maxEdge pixels on its long edge.
	func shoot(_ window: SCWindow, maxEdge: Int) async throws -> CGImage {
		let filter = SCContentFilter(desktopIndependentWindow: window)
		let scale = Double(filter.pointPixelScale)
		let (w, h) = (Double(window.frame.width) * scale, Double(window.frame.height) * scale)
		guard w >= 1, h >= 1 else { throw RPCError.notFound("window \(window.windowID) has no size") }
		let factor = min(1, Double(maxEdge) / max(w, h))
		let config = SCStreamConfiguration()
		config.width = max(1, Int((w * factor).rounded()))
		config.height = max(1, Int((h * factor).rounded()))
		config.showsCursor = false
		config.ignoreShadowsSingleWindow = true
		do {
			return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
		} catch {
			throw RPCError.denied("window \(window.windowID) cannot be captured: \(error.localizedDescription)")
		}
	}

	func window(_ target: ResolvedTarget, maxEdge: Int, maxBytes: Int) async throws -> ComputerdKit.Image {
		let window = try await scWindow(target)
		var edge = maxEdge
		while true {
			let image = try await shoot(window, maxEdge: edge)
			let scale = Double(image.width) / max(1, Double(window.frame.width))
			if let png = Encode.png(image), png.count <= maxBytes {
				return ComputerdKit.Image(data: png, format: "png", width: image.width, height: image.height, scale: scale)
			}
			for quality in [0.8, 0.6, 0.4] {
				if let jpeg = Encode.jpeg(image, quality: quality), jpeg.count <= maxBytes {
					return ComputerdKit.Image(data: jpeg, format: "jpeg", width: image.width, height: image.height, scale: scale)
				}
			}
			guard edge > 64 else { throw RPCError.limit("window \(target.window.id)'s image does not fit in \(maxBytes) bytes") }
			edge = edge * 3 / 4
		}
	}

	/// The main display's filter, and its size in points and pixels.
	func mainDisplay() async throws -> (filter: SCContentFilter, points: CGSize, scale: Double) {
		let id = CGMainDisplayID()
		guard let display = try await shareable().displays.first(where: { $0.displayID == id }) else {
			throw RPCError.notFound("the main display is not shareable")
		}
		let filter = SCContentFilter(display: display, excludingWindows: [])
		return (filter, CGSize(width: display.width, height: display.height), Double(filter.pointPixelScale))
	}

	func screen(region: Rect?) async throws -> ComputerdKit.Image {
		let (filter, points, scale) = try await mainDisplay()
		let config = SCStreamConfiguration()
		config.showsCursor = false
		if let region {
			// The region is in pixels; ScreenCaptureKit takes points.
			config.sourceRect = CGRect(x: region.x / scale, y: region.y / scale, width: region.w / scale, height: region.h / scale)
			config.width = Int(region.w.rounded())
			config.height = Int(region.h.rounded())
		} else {
			config.width = Int((Double(points.width) * scale).rounded())
			config.height = Int((Double(points.height) * scale).rounded())
		}
		let image: CGImage
		do {
			image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
		} catch {
			throw RPCError.denied("the screen cannot be captured: \(error.localizedDescription)")
		}
		guard let png = Encode.png(image) else { throw RPCError.invalid("the screen's image would not encode") }
		return ComputerdKit.Image(data: png, format: "png", width: image.width, height: image.height, scale: scale)
	}

	func frame(maxWidth: Int, quality: Int) async throws -> ComputerdKit.Image {
		let (filter, points, scale) = try await mainDisplay()
		let full = Double(points.width) * scale
		let factor = min(1, Double(maxWidth) / max(1, full))
		let config = SCStreamConfiguration()
		config.showsCursor = true
		config.width = max(1, Int((full * factor).rounded()))
		config.height = max(1, Int((Double(points.height) * scale * factor).rounded()))
		let image: CGImage
		do {
			image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
		} catch {
			throw RPCError.denied("the screen cannot be captured: \(error.localizedDescription)")
		}
		guard let jpeg = Encode.jpeg(image, quality: Double(quality) / 100) else { throw RPCError.invalid("the screen's image would not encode") }
		return ComputerdKit.Image(data: jpeg, format: "jpeg", width: image.width, height: image.height, scale: Double(image.width) / max(1, Double(points.width)))
	}

	/// A hash of a small image of the window: changes when the window looks different.
	func windowHash(_ target: ResolvedTarget) async -> Int? {
		guard feature.isOn, let window = try? await scWindow(target), let image = try? await shoot(window, maxEdge: 96) else { return nil }
		guard let data = image.dataProvider?.data as Data? else { return nil }
		return data.hashValue
	}

	func screenInfo() -> ScreenInfo? {
		let id = CGMainDisplayID()
		let bounds = CGDisplayBounds(id)
		guard bounds.width > 0, let mode = CGDisplayCopyDisplayMode(id) else { return nil }
		let scale = mode.width > 0 ? Double(mode.pixelWidth) / Double(mode.width) : 1
		return ScreenInfo(width: Double(bounds.width), height: Double(bounds.height), scale: scale)
	}

	func cursor() -> Point? {
		guard let at = CGEvent(source: nil)?.location else { return nil }
		let scale = screenInfo()?.scale ?? 1
		return Point((Double(at.x) * scale).rounded(), (Double(at.y) * scale).rounded())
	}
}

enum Encode {
	static func png(_ image: CGImage) -> Data? { encode(image, UTType.png, [:]) }

	static func jpeg(_ image: CGImage, quality: Double) -> Data? {
		encode(image, UTType.jpeg, [kCGImageDestinationLossyCompressionQuality: quality])
	}

	static func encode(_ image: CGImage, _ type: UTType, _ options: [CFString: Any]) -> Data? {
		let out = NSMutableData()
		guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
		CGImageDestinationAddImage(dest, image, options as CFDictionary)
		guard CGImageDestinationFinalize(dest) else { return nil }
		return out as Data
	}
}
#endif
