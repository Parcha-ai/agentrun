// Crops mini-demos.py's movie frames to the demo's own window, so no frame of a person's desktop reaches a file. One
// process a run; it reads a request a line on stdin and answers a line on stdout, both JSON:
//
//   {"op": "where", "window": "1234"}
//     -> {"bounds": [x, y, w, h], "above": [[x, y, w, h], ...]}   the window on screen, in points, and every window in
//        front of it that overlaps it: another app's, or one of its own app's ordinary windows (not its menus or
//        popovers, which are the demo's own). {"bounds": null} when the window is not on screen.
//   {"op": "crop", "jpeg": BASE64, "bounds": [...], "above": [...], "out": PATH, "quality": 70}
//     -> {"width": W, "height": H}   the screen frame cut to the bounds, each overlapping window painted black, written
//        to PATH as a JPEG. The frame covers the main display, at any scale.
//
// The window list gives bounds and ids without Screen Recording, so this needs no grant of its own.
//
//   swift window-frames.swift
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func answer(_ object: Any) {
	let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"error\": \"no answer\"}".utf8)
	FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func rect(_ value: Any?) -> CGRect? {
	guard let a = value as? [Double], a.count == 4 else { return nil }
	return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
}

func list(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }

func number(_ info: [String: Any], _ key: CFString) -> Int? { (info[key as String] as? NSNumber)?.intValue }

/// The window and what is in front of it, from the window server's list (front to back).
func locate(_ id: Int) -> [String: Any] {
	let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
	guard let index = windows.firstIndex(where: { number($0, kCGWindowNumber) == id }),
		let dict = windows[index][kCGWindowBounds as String] as? NSDictionary,
		let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary)
	else { return ["bounds": NSNull()] }
	let owner = number(windows[index], kCGWindowOwnerPID)
	var above: [[Double]] = []
	for info in windows[..<index] {
		// A window drawn with nothing (alpha 0) hides nothing.
		if let alpha = info[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue == 0 { continue }
		// The demo app's own menus and popovers belong in its movie; its other ordinary windows may be a person's.
		if number(info, kCGWindowOwnerPID) == owner && number(info, kCGWindowLayer) != 0 { continue }
		guard let d = info[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: d as CFDictionary) else { continue }
		let overlap = r.intersection(bounds)
		if !overlap.isNull && overlap.width > 0 && overlap.height > 0 { above.append(list(overlap)) }
	}
	return ["bounds": list(bounds), "above": above]
}

func crop(_ request: [String: Any]) throws -> [String: Any] {
	guard let b64 = request["jpeg"] as? String, let data = Data(base64Encoded: b64),
		let source = CGImageSourceCreateWithData(data as CFData, nil), let frame = CGImageSourceCreateImageAtIndex(source, 0, nil)
	else { throw Failure("the frame is not an image") }
	guard let bounds = rect(request["bounds"]), let out = request["out"] as? String else { throw Failure("crop needs bounds and out") }
	let above = (request["above"] as? [Any] ?? []).compactMap(rect)
	let display = CGDisplayBounds(CGMainDisplayID())
	guard display.width > 0 else { throw Failure("no main display") }
	let scale = Double(frame.width) / display.width
	let shown = bounds.intersection(display)
	guard !shown.isNull, shown.width >= 1, shown.height >= 1 else { throw Failure("the window is off the main display") }
	func pixels(_ r: CGRect) -> CGRect {
		CGRect(x: (r.minX - display.minX) * scale, y: (r.minY - display.minY) * scale, width: r.width * scale, height: r.height * scale).integral
	}
	let cut = pixels(shown).intersection(CGRect(x: 0, y: 0, width: frame.width, height: frame.height))
	guard let window = frame.cropping(to: cut) else { throw Failure("the frame would not crop") }
	let (w, h) = (window.width, window.height)
	guard let context = CGContext(
		data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
		bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
	) else { throw Failure("no drawing context") }
	context.draw(window, in: CGRect(x: 0, y: 0, width: w, height: h))
	// Each window in front, in the cut's pixels: CoreGraphics' origin is the bottom left, the window list's the top left.
	context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
	for r in above {
		let p = pixels(r).insetBy(dx: -2, dy: -2)
		context.fill(CGRect(x: p.minX - cut.minX, y: Double(h) - (p.maxY - cut.minY), width: p.width, height: p.height))
	}
	guard let image = context.makeImage(),
		let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
	else { throw Failure("cannot write \(out)") }
	let quality = Double(request["quality"] as? Int ?? 70) / 100
	CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
	guard CGImageDestinationFinalize(destination) else { throw Failure("cannot write \(out)") }
	return ["width": w, "height": h]
}

struct Failure: Error {
	let words: String
	init(_ words: String) { self.words = words }
}

while let line = readLine(strippingNewline: true) {
	guard let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else {
		answer(["error": "not a JSON object"])
		continue
	}
	switch request["op"] as? String {
	case "where":
		guard let id = (request["window"] as? String).flatMap({ Int($0) }) else {
			answer(["error": "where needs a window id"])
			continue
		}
		answer(locate(id))
	case "crop":
		do {
			answer(try crop(request))
		} catch let failure as Failure {
			answer(["error": failure.words])
		} catch {
			answer(["error": "\(error)"])
		}
	default:
		answer(["error": "op is where or crop"])
	}
}
