import Foundation

/// The images a connection holds for chunked reading: screen.shot's, and ui.observe's window images. Each carries its
/// first chunk inline; screen.read reads the rest by id and offset, and the image is let go at its end or once newer
/// ones push it out.
public actor ShotStore {
	static let held = 4
	let chunk: Int
	var images: [(id: String, data: Data)] = []
	var next = 1

	public init(chunk: Int = Limits.maxChunkBytes) {
		self.chunk = chunk
	}

	/// Holds data unless it fits one chunk; answers its id, its first chunk, and whether that was all of it.
	public func hold(_ data: Data) -> (id: String, first: Data, eof: Bool) {
		let id = "img\(next)"
		next += 1
		let eof = data.count <= chunk
		if !eof {
			images.append((id, data))
			if images.count > Self.held { images.removeFirst(images.count - Self.held) }
		}
		return (id, data.prefix(chunk), eof)
	}

	public func read(_ id: String, offset: Int) throws -> ScreenReadResult {
		guard let index = images.firstIndex(where: { $0.id == id }) else {
			throw RPCError.notFound("no image \(id) is held: it was read to its end, or newer images let it go")
		}
		let data = images[index].data
		guard offset >= 0, offset <= data.count else {
			throw RPCError.invalid("offset \(offset) is outside the image's \(data.count) bytes")
		}
		let end = min(data.count, offset + chunk)
		let eof = end == data.count
		if eof { images.remove(at: index) }
		return ScreenReadResult(data: data.subdata(in: offset..<end), eof: eof)
	}
}
