#if os(macOS)
import ComputerdKit
import Darwin
import Foundation

/// What the app writes to its log: ~/Library/Logs/Computerd.log, and stderr. Never a token.
public func log(_ words: String) {
	let line = Data("\(ISO8601DateFormatter().string(from: Date())) \(words)\n".utf8)
	LogFile.lock.lock()
	defer { LogFile.lock.unlock() }
	FileHandle.standardError.write(line)
	LogFile.handle?.seekToEndOfFile()
	LogFile.handle?.write(line)
}

enum LogFile {
	static let lock = NSLock()
	static let path = NSHomeDirectory() + "/Library/Logs/Computerd.log"
	nonisolated(unsafe) static let handle: FileHandle? = {
		if !FileManager.default.fileExists(atPath: path) {
			FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
		}
		return FileHandle(forWritingAtPath: path)
	}()
}

/// The app's unix socket: the stdio binding over a socket only this user's Computerd binaries may open. Each
/// connection gets a driver of its own.
public final class SocketServer: @unchecked Sendable {
	let path: String
	let auth: PeerAuth
	let makeDriver: @Sendable () -> Driver
	var listener: Int32 = -1

	public init(path: String = Paths.socket, auth: PeerAuth, makeDriver: @escaping @Sendable () -> Driver) {
		self.path = path
		self.auth = auth
		self.makeDriver = makeDriver
	}

	public func start() throws {
		listener = try UnixSocket.listen(path)
		log("listening on \(path)")
		let listener = self.listener
		let thread = Thread { [self] in
			while let fd = UnixSocket.accept(listener) {
				if let why = auth.refuse(fd) {
					log("refused a client: \(why)")
					let reply = #"{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Computerd refused this client: "# + Self.escape(why) + #"","data":{"kind":"denied"}}}"#
					FDOutput.writeAll(fd, Data((reply + "\n").utf8))
					close(fd)
					continue
				}
				Task { await self.serve(fd) }
			}
		}
		thread.start()
	}

	static func escape(_ s: String) -> String {
		String(String(decoding: (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8), as: UTF8.self).dropFirst().dropLast())
	}

	func serve(_ fd: Int32) async {
		let driver = makeDriver()
		let connection = Connection(router: driver.router(), output: FDOutput(fd: fd))
		await connection.serve(FDLines.read(fd: fd))
		await driver.close()
		close(fd)
	}
}
#endif
