// Makes an H.264 movie from mini-demos.py's frames (each already cut to the demo's window by window-frames.swift): each
// frame shown from its time to the next, the current caption written along the bottom. AVFoundation only, so a Mac
// with Xcode has all it needs.
//
//   swift frames-to-movie.swift TIMELINE.txt OUT.mp4
//
// TIMELINE.txt has one event a line, times in seconds from the task's start:
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
var end = 0.0
for line in timeline.split(separator: "\n") {
	let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
	guard parts.count >= 2, let at = Double(parts[1]) else { continue }
	switch parts[0] {
	case "frame" where parts.count == 3: frames.append((at, parts[2]))
	case "caption" where parts.count == 3: captions.append((at, parts[2]))
	case "end": end = at
	default: break
	}
}
guard !frames.isEmpty else { fail("no frames in \(arguments[1])") }

func image(_ path: String) -> CGImage? {
	guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
	return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

guard let first = image(frames[0].path) else { fail("cannot read \(frames[0].path)") }
let width = first.width & ~1
let height = first.height & ~1
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
let font = CTFontCreateWithName("Helvetica Neue" as CFString, CGFloat(max(14, height / 36)), nil)
let band = CGFloat(max(28, height / 18))

/// One movie frame: the window's frame, fit to the movie (the window may change size, and the movie is the first
/// frame's), and the caption on a dark band at the bottom.
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
	let fit = min(Double(width) / Double(picture.width), Double(height) / Double(picture.height))
	let (w, h) = (Double(picture.width) * fit, Double(picture.height) * fit)
	context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
	context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	context.draw(picture, in: CGRect(x: (Double(width) - w) / 2, y: (Double(height) - h) / 2, width: w, height: h))
	if !caption.isEmpty {
		context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.72))
		context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: band))
		let text = NSAttributedString(string: caption, attributes: [
			NSAttributedString.Key(kCTFontAttributeName as String): font,
			NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 1, blue: 1, alpha: 1),
		])
		let line = CTLineCreateWithAttributedString(text)
		context.textPosition = CGPoint(x: band / 2, y: band / 2 - CTFontGetAscent(font) / 2 + CTFontGetDescent(font) / 2)
		CTLineDraw(line, context)
	}
	return buffer
}

// Every frame and every caption change is a moment of the movie; a caption change repeats the frame before it.
var moments = frames.map { (at: $0.at, frame: Optional($0.path)) } + captions.map { (at: $0.at, frame: String?.none) }
moments.sort { $0.at < $1.at }
let start = frames[0].at
var picture = first
var last = -1.0
for moment in moments where moment.at >= start {
	if let path = moment.frame, let next = image(path) { picture = next }
	let caption = captions.last(where: { $0.at <= moment.at })?.text ?? ""
	let at = max(moment.at - start, last + 1.0 / 60)
	while !input.isReadyForMoreMediaData { usleep(2000) }
	adaptor.append(draw(picture, caption: caption), withPresentationTime: CMTime(seconds: at, preferredTimescale: 600))
	last = at
}
input.markAsFinished()
writer.endSession(atSourceTime: CMTime(seconds: max(end - start, last + 0.5), preferredTimescale: 600))
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { fail("the movie was not finished: \(String(describing: writer.error))") }
print(output.path)
