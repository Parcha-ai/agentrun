#if os(macOS)
import AppKit
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
	/// Where ui.act last acted: the live view's frames draw it (frame), no other image does.
	private let marks: Marks
	private let clock = SystemClock()

	init(marks: Marks) {
		self.marks = marks
	}

	var feature: Feature {
		CGPreflightScreenCaptureAccess()
			? .on
			: .off("Screen Recording is not granted to Computerd: allow it in System Settings > Privacy & Security > Screen & System Audio Recording")
	}

	/// The app and window a target names, from the window server's list, while the tree is off. The window ids are the
	/// window server's, as the tree's resolve gives them. Without a window named: the app's frontmost window on screen.
	func resolve(_ target: Target?) throws -> ResolvedTarget {
		let app = try MacAccessibility.runningApp(target?.app)
		let pid = app.processIdentifier
		let id = app.bundleIdentifier ?? "pid.\(pid)"
		func number(_ info: [String: Any], _ key: CFString) -> NSNumber? { info[key as String] as? NSNumber }
		let info: [String: Any]
		if let wanted = target?.window {
			guard let wid = CGWindowID(wanted),
				let found = (CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]])?.first,
				number(found, kCGWindowOwnerPID)?.int32Value == pid
			else {
				throw RPCError.notFound("\(id) has no window \(wanted): observe it without a window for its frontmost one")
			}
			info = found
		} else {
			// On screen, front to back; layer 0 holds an app's ordinary windows.
			let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
			guard let front = list.first(where: { number($0, kCGWindowOwnerPID)?.int32Value == pid && number($0, kCGWindowLayer)?.intValue == 0 }) else {
				throw RPCError.notFound("\(id) has no window on screen\(app.isHidden ? ": it is hidden" : "")")
			}
			info = front
		}
		guard let wid = number(info, kCGWindowNumber)?.uint32Value,
			let dict = info[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary)
		else {
			throw RPCError.notFound("\(id)'s window has no number or frame in the window list")
		}
		let title = (info[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
		return ResolvedTarget(
			app: UiApp(id: id, name: app.localizedName ?? id, pid: Int(pid)), pid: pid,
			window: UiWindow(id: String(wid), title: title, bounds: Rect(Double(bounds.minX), Double(bounds.minY), Double(bounds.width), Double(bounds.height))))
	}

	/// What is on screen, kept a second: listing it is the slow part of a capture.
	func shareable() async throws -> SCShareableContent {
		let cached = lock.withLock { content }
		if let cached, Date().timeIntervalSince(cached.at) < 1 { return cached.value }
		let fresh: SCShareableContent
		do {
			fresh = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
		} catch {
			throw RPCError.denied("the screen cannot be read: \(error.localizedDescription)")
		}
		lock.withLock { content = (Date(), fresh) }
		return fresh
	}

	func scWindow(_ target: ResolvedTarget) async throws -> SCWindow {
		guard let wid = CGWindowID(target.window.id) else { throw RPCError.notFound("window \(target.window.id) is not a window server id") }
		if let found = try await shareable().windows.first(where: { $0.windowID == wid }) { return found }
		lock.withLock { content = nil }
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
		let perPoint = Double(image.width) / max(1, Double(points.width))
		let shown = marks.scene(now: clock.now()).flatMap { Self.draw($0, on: image, scale: perPoint) } ?? image
		guard let jpeg = Encode.jpeg(shown, quality: Double(quality) / 100) else { throw RPCError.invalid("the screen's image would not encode") }
		return ComputerdKit.Image(data: jpeg, format: "jpeg", width: image.width, height: image.height, scale: perPoint)
	}

	/// The live view's frame with the last step's place drawn on it (Marks): a pointer there, a ring growing out of a
	/// press, a box around a typed-into field. In the frame's pixels, scale per screen point; the main display's
	/// origin is the screen's.
	static func draw(_ scene: Marks.Scene, on image: CGImage, scale: Double) -> CGImage? {
		let (w, h) = (image.width, image.height)
		guard let context = CGContext(
			data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
		) else { return nil }
		context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
		// CoreGraphics' origin is the bottom left, the screen's the top left.
		func at(_ p: Point) -> CGPoint { CGPoint(x: p.x * scale, y: Double(h) - p.y * scale) }
		let accent = (red: 0.0, green: 0.48, blue: 1.0)
		if let box = scene.box {
			let origin = at(Point(box.x, box.y + box.h))
			let rect = CGRect(x: origin.x, y: origin.y, width: box.w * scale, height: box.h * scale).insetBy(dx: -3 * scale, dy: -3 * scale)
			context.setStrokeColor(CGColor(red: accent.red, green: accent.green, blue: accent.blue, alpha: 0.9 * scene.boxAlpha))
			context.setLineWidth(2.5 * scale)
			context.addPath(CGPath(roundedRect: rect, cornerWidth: 5 * scale, cornerHeight: 5 * scale, transform: nil))
			context.strokePath()
		}
		let tip = at(scene.pointer)
		if let ring = scene.ring {
			let radius = (8 + 22 * ring) * scale
			context.setStrokeColor(CGColor(red: accent.red, green: accent.green, blue: accent.blue, alpha: 0.85 * (1 - ring)))
			context.setLineWidth(3 * scale)
			context.strokeEllipse(in: CGRect(x: tip.x - radius, y: tip.y - radius, width: radius * 2, height: radius * 2))
		}
		// An arrow pointer, its tip on the place: white, outlined dark, with the accent in its tail so it reads as the
		// agent's and not the person's.
		let u = scale
		let arrow: [(Double, Double)] = [(0, 0), (0, 17), (4.2, 13), (7, 19.5), (9.6, 18.4), (6.9, 12), (12.5, 12)]
		let path = CGMutablePath()
		path.addLines(between: arrow.map { CGPoint(x: tip.x + $0.0 * u, y: tip.y - $0.1 * u) })
		path.closeSubpath()
		context.setShadow(offset: CGSize(width: 0, height: -1.5 * u), blur: 3 * u, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.45 * scene.alpha))
		context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: scene.alpha))
		context.addPath(path)
		context.fillPath()
		context.setShadow(offset: .zero, blur: 0, color: nil)
		context.setStrokeColor(CGColor(red: 0.05, green: 0.05, blue: 0.05, alpha: scene.alpha))
		context.setLineWidth(1.2 * u)
		context.setLineJoin(.round)
		context.addPath(path)
		context.strokePath()
		context.setFillColor(CGColor(red: accent.red, green: accent.green, blue: accent.blue, alpha: scene.alpha))
		context.fillEllipse(in: CGRect(x: tip.x + 9 * u, y: tip.y - 24 * u, width: 7 * u, height: 7 * u))
		return context.makeImage()
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
