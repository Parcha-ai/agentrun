import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Splits bytes into lines of at most maxLineBytes (without the newline). A longer line keeps only its start, so its id
/// can still be read, and the rest up to its newline is dropped.
public struct LineSplitter: Sendable {
	public let maxLineBytes: Int
	var current = Data()
	var overLimit = false
	static let keepOfLongLine = 512

	public init(maxLineBytes: Int = Limits.maxLineBytes) {
		self.maxLineBytes = maxLineBytes
	}

	public mutating func feed(_ chunk: Data) -> [Line] {
		var out: [Line] = []
		var start = chunk.startIndex
		while start < chunk.endIndex {
			let newline = chunk[start...].firstIndex(of: 10)
			let end = newline ?? chunk.endIndex
			append(chunk[start..<end])
			if newline != nil {
				out.append(finish())
				start = end + 1
			} else {
				start = end
			}
		}
		return out
	}

	/// The last line, when the input ended without a newline.
	public mutating func end() -> Line? {
		if current.isEmpty && !overLimit { return nil }
		return finish()
	}

	mutating func append(_ bytes: Data) {
		if overLimit { return }
		if current.count + bytes.count > maxLineBytes {
			let room = max(0, Self.keepOfLongLine - current.count)
			current.append(bytes.prefix(room))
			current = current.prefix(Self.keepOfLongLine)
			overLimit = true
			return
		}
		current.append(bytes)
	}

	mutating func finish() -> Line {
		defer {
			current = Data()
			overLimit = false
		}
		return overLimit ? .tooLong(prefix: current) : .data(current)
	}
}

/// Lines read from a file descriptor (stdin, a socket) on a thread of their own, as an async sequence.
public enum FDLines {
	public static func read(fd: Int32, maxLineBytes: Int = Limits.maxLineBytes) -> AsyncStream<Line> {
		let (stream, continuation) = AsyncStream<Line>.makeStream()
		let thread = Thread {
			var splitter = LineSplitter(maxLineBytes: maxLineBytes)
			var buffer = [UInt8](repeating: 0, count: 64 * 1024)
			while true {
				let n = buffer.withUnsafeMutableBytes { sysRead(fd, $0.baseAddress, $0.count) }
				if n < 0 && errno == EINTR { continue }
				if n <= 0 { break }
				for line in splitter.feed(Data(buffer[0..<n])) { continuation.yield(line) }
			}
			if let last = splitter.end() { continuation.yield(last) }
			continuation.finish()
		}
		thread.start()
		return stream
	}
}

/// Writes whole lines to a file descriptor, one at a time. A write to a peer that went away is dropped.
public actor FDOutput: LineOutput {
	let fd: Int32

	public init(fd: Int32) {
		self.fd = fd
	}

	public func send(_ line: Data) async {
		var bytes = line
		bytes.append(10)
		Self.writeAll(fd, bytes)
	}

	@discardableResult
	public static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
		data.withUnsafeBytes { raw in
			var offset = 0
			while offset < raw.count {
				let n = sysWrite(fd, raw.baseAddress! + offset, raw.count - offset)
				if n < 0 {
					if errno == EINTR { continue }
					return false
				}
				offset += n
			}
			return true
		}
	}
}
