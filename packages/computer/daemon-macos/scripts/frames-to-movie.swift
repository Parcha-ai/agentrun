// Makes an H.264 movie from mini-demos.py's frames (each already cut to the demo's window by window-frames.swift), at a
// steady 30 frames a second: each frame shown from its time until the next, the window centered on a dark backdrop
// with its shadow, the task's title above it and the current step's caption below. A still stretch past its first
// second plays at 4× with a mark saying so. AVFoundation only, so a Mac with Xcode has all it needs.
//
//   swift frames-to-movie.swift TIMELINE.txt OUT.mp4
//
// TIMELINE.txt has one event a line, times in seconds from the task's start:
//   title Rename draft.txt to final.txt in Finder
//   start 0.900                         the movie's first moment (the first frame's when absent)
//   frame 1.250 /path/00003.jpg
//   caption 1.300 open totals.txt in TextEdit
//   end 9.800
import AVFoundation
import CoreText
import Foundation
import ImageIO

func fail(_ words: String) -> Never {
	FileHandle.standardError.write(Data("frames-to-movie: \(words)\n".utf8))
	exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else { fail("usage: swift frames-to-movie.swift TIMELINE.txt OUT.mp4") }
guard let timeline = try? String(contentsOfFile: arguments[1], encoding: .utf8) else { fail("cannot read \(arguments[1])") }

var frames: [(at: Double, path: String)] = []
var captions: [(at: Double, text: String)] = []
var title = ""
var from: Double?
var end = 0.0
for line in timeline.split(separator: "\n") {
	let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
	if parts.first == "title" {
		title = String(line.dropFirst("title ".count))
		continue
	}
	guard parts.count >= 2, let at = Double(parts[1]) else { continue }
	switch parts[0] {
	case "frame" where parts.count == 3: frames.append((at, parts[2]))
	case "caption" where parts.count == 3: captions.append((at, parts[2]))
	case "start": from = at
	case "end": end = at
	default: break
	}
}
guard !frames.isEmpty else { fail("no frames in \(arguments[1])") }
frames.sort { $0.at < $1.at }
captions.sort { $0.at < $1.at }

func image(_ path: String) -> CGImage? {
	guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
	return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

/// A frame's size, read from its header without decoding it.
func size(_ path: String) -> (Int, Int)? {
	guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
		let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
		let w = properties[kCGImagePropertyPixelWidth] as? Int, let h = properties[kCGImagePropertyPixelHeight] as? Int
	else { return nil }
	return (w, h)
}

// The window's place: as large as its largest frame, so a window that grows is never scaled down mid-movie.
let sizes = frames.compactMap { size($0.path) }
guard !sizes.isEmpty else { fail("cannot read \(frames[0].path)") }
let windowW = sizes.map { $0.0 }.max()!
let windowH = sizes.map { $0.1 }.max()!
let pad = max(28, windowW / 22)
let fontSize = CGFloat(max(15, min(26, windowW / 46)))
let band = Int(fontSize * 2.6)
let width = (windowW + pad * 2 + 1) & ~1
let height = (windowH + pad * 2 + band * (title.isEmpty ? 1 : 2) + 1) & ~1
let fps = 30.0

let output = URL(fileURLWithPath: arguments[2])
try? FileManager.default.removeItem(at: output)
let writer: AVAssetWriter
do {
	writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
} catch {
	fail("cannot write \(output.path): \(error)")
}
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
	AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
	AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: width * height * 4, AVVideoExpectedSourceFrameRateKey: Int(fps)],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
	kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
	kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
guard writer.startWriting() else { fail("cannot start writing: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

let space = CGColorSpaceCreateDeviceRGB()
let regular = CTFontCreateWithName("Helvetica Neue" as CFString, fontSize, nil)
let bold = CTFontCreateWithName("Helvetica Neue Medium" as CFString, fontSize * 1.05, nil)

/// One line of text, centered on x at baseline-middle y, cut with an ellipsis to fit the width.
func write(_ words: String, font: CTFont, color: CGColor, centerX: CGFloat, midY: CGFloat, maxWidth: CGFloat, in context: CGContext) {
	var text = words
	var line: CTLine
	repeat {
		line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
			NSAttributedString.Key(kCTFontAttributeName as String): font,
			NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
		]))
		if CTLineGetTypographicBounds(line, nil, nil, nil) <= maxWidth || text.count < 4 { break }
		text = String(text.dropLast(4)) + "…"
	} while true
	let lineWidth = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
	context.textPosition = CGPoint(x: centerX - lineWidth / 2, y: midY - (CTFontGetAscent(font) - CTFontGetDescent(font)) / 2)
	CTLineDraw(line, context)
}

/// One movie frame: the backdrop, the title above, the window in the middle with its shadow and rounded corners, the
/// caption below.
func draw(_ picture: CGImage, caption: String) -> CVPixelBuffer {
	var made: CVPixelBuffer?
	guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) == kCVReturnSuccess, let buffer = made else {
		fail("no pixel buffer")
	}
	CVPixelBufferLockBaseAddress(buffer, [])
	defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
	guard let context = CGContext(
		data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
		bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: space, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
	) else { fail("no drawing context") }
	let top = CGColor(red: 0.13, green: 0.15, blue: 0.20, alpha: 1)
	let bottom = CGColor(red: 0.05, green: 0.06, blue: 0.09, alpha: 1)
	if let gradient = CGGradient(colorsSpace: space, colors: [bottom, top] as CFArray, locations: [0, 1]) {
		context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: height), options: [])
	}
	// CoreGraphics' origin is the bottom left: the caption's band, then the window's place, then the title's band.
	let place = CGRect(x: pad, y: band + pad, width: windowW, height: windowH)
	let fit = min(1, min(Double(windowW) / Double(picture.width), Double(windowH) / Double(picture.height)))
	let (w, h) = (Double(picture.width) * fit, Double(picture.height) * fit)
	let rect = CGRect(x: place.midX - w / 2, y: place.midY - h / 2, width: w, height: h).integral
	let corners = CGPath(roundedRect: rect, cornerWidth: 12, cornerHeight: 12, transform: nil)
	context.saveGState()
	context.setShadow(offset: CGSize(width: 0, height: -10), blur: 36, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.6))
	context.addPath(corners)
	context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
	context.fillPath()
	context.restoreGState()
	context.saveGState()
	context.addPath(corners)
	context.clip()
	context.draw(picture, in: rect)
	context.restoreGState()
	let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
	let muted = CGColor(red: 0.78, green: 0.82, blue: 0.9, alpha: 1)
	let textWidth = CGFloat(width - pad * 2)
	if !title.isEmpty {
		write(title, font: bold, color: white, centerX: CGFloat(width) / 2, midY: CGFloat(height - band / 2 - pad / 3), maxWidth: textWidth, in: context)
	}
	if !caption.isEmpty {
		write(caption, font: regular, color: muted, centerX: CGFloat(width) / 2, midY: CGFloat(band / 2 + pad / 3), maxWidth: textWidth, in: context)
	}
	return buffer
}

// Every 1/30 s from the start (the task's, else the first frame's) to the end: the latest frame and caption at that
// time. A frame from well before the start is the setup's (Notes' welcome sheet, answered before the task): the movie
// starts at the task's first frame instead.
var start = from ?? frames[0].at
let last = end > start ? end : frames.last!.at + 1.2
// A caption from before the start is the setup's, not the task's.
captions.removeAll { $0.at < start }
if let first = frames.firstIndex(where: { $0.at >= start - 0.5 }) {
	frames.removeFirst(first)
	start = max(start, frames[0].at)
} else {
	frames = [frames.last!]
}
// A still stretch (no new frame, no new caption) plays at `fast` times its speed after its first `still` seconds, with a
// mark in the corner saying so: an agent's turns wait on its model, and a window that does not change for ten seconds
// shows nothing. The movie's time is the run's elsewhere.
let still = 1.0
let fast = 4.0
let small = CTFontCreateWithName("Helvetica Neue Medium" as CFString, fontSize * 0.8, nil)
var index = 0
var caption = 0
var picture = image(frames[0].path)!
var shown = -1
var count = 0
var t = start
while t <= last {
	while index + 1 < frames.count && frames[index + 1].at <= t { index += 1 }
	if index != shown, let next = image(frames[index].path) {
		picture = next
		shown = index
	}
	while caption < captions.count && captions[caption].at <= t { caption += 1 }
	let words = caption > 0 ? captions[caption - 1].text : ""
	let changed = max(frames[index].at, caption > 0 ? captions[caption - 1].at : start, start)
	let sped = t - changed > still
	let buffer = draw(picture, caption: words)
	if sped {
		CVPixelBufferLockBaseAddress(buffer, [])
		if let context = CGContext(
			data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
			bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: space, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
		) {
			// Above the window's top right corner, in the gap between it and the title.
			write("\(Int(fast))× while nothing changes", font: small, color: CGColor(red: 0.6, green: 0.65, blue: 0.75, alpha: 1),
				centerX: CGFloat(width - pad) - 150, midY: CGFloat(height - band - pad / 2), maxWidth: 300, in: context)
		}
		CVPixelBufferUnlockBaseAddress(buffer, [])
	}
	while !input.isReadyForMoreMediaData { usleep(2000) }
	adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(count), timescale: CMTimeScale(fps)))
	count += 1
	t += (sped ? fast : 1) / fps
}
input.markAsFinished()
writer.endSession(atSourceTime: CMTime(value: CMTimeValue(count), timescale: CMTimeScale(fps)))
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { fail("the movie was not finished: \(String(describing: writer.error))") }
print(output.path)
