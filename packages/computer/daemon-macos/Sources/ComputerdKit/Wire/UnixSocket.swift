import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Where Computerd.app listens, and where its files live.
public enum Paths {
	/// ~/Library/Application Support/Computerd, or $COMPUTERD_HOME.
	public static var home: String {
		if let given = ProcessInfo.processInfo.environment["COMPUTERD_HOME"], !given.isEmpty { return given }
		return NSHomeDirectory() + "/Library/Application Support/Computerd"
	}

	/// The app's socket: mode 0600 in a 0700 directory, so only the user reaches it, and each client's code signature
	/// is checked as well.
	public static var socket: String {
		if let given = ProcessInfo.processInfo.environment["COMPUTERD_SOCKET"], !given.isEmpty { return given }
		return home + "/computerd.sock"
	}

	/// The attach binding's settings: the server this Mac is paired with, and its computer id.
	public static var attach: String { home + "/attach.json" }

	/// The owner's policy for this Mac: the apps a connection may touch, and what the paired server may use.
	public static var policy: String { home + "/policy.json" }

	/// A path as words show it: under the user's home, from "~".
	public static func shown(_ path: String) -> String {
		let home = NSHomeDirectory()
		return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
	}
}

/// A unix stream socket: listen on a path, accept, connect.
public enum UnixSocket {
	static func address(_ path: String) throws -> sockaddr_un {
		var addr = sockaddr_un()
		addr.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(path.utf8)
		let capacity = MemoryLayout.size(ofValue: addr.sun_path)
		guard bytes.count < capacity else { throw RPCError.invalid("the socket path \(path) is longer than \(capacity - 1) bytes") }
		withUnsafeMutableBytes(of: &addr.sun_path) { raw in
			raw.copyBytes(from: bytes)
			raw[bytes.count] = 0
		}
		return addr
	}

	static func socketFD() throws -> Int32 {
		#if canImport(Darwin)
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		#else
		let fd = socket(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0)
		#endif
		guard fd >= 0 else { throw RPCError.invalid("cannot make a socket: \(String(cString: strerror(errno)))") }
		_ = fcntl(fd, F_SETFD, FD_CLOEXEC)
		#if canImport(Darwin)
		var on: Int32 = 1
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
		#endif
		return fd
	}

	/// Listens on path, made fresh: its directory 0700, the socket 0600.
	public static func listen(_ path: String) throws -> Int32 {
		let dir = (path as NSString).deletingLastPathComponent
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		_ = chmod(dir, 0o700)
		unlink(path)
		let fd = try socketFD()
		var addr = try address(path)
		let old = umask(0o177)
		defer { umask(old) }
		let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
		guard bound == 0 else {
			let code = errno
			sysClose(fd)
			throw RPCError.invalid("cannot listen on \(path): \(String(cString: strerror(code)))")
		}
		guard sysListen(fd, 16) == 0 else {
			let code = errno
			sysClose(fd)
			throw RPCError.invalid("cannot listen on \(path): \(String(cString: strerror(code)))")
		}
		return fd
	}

	/// The next connection; nil when the listener closed.
	public static func accept(_ listener: Int32) -> Int32? {
		while true {
			let fd = sysAccept(listener)
			if fd >= 0 {
				_ = fcntl(fd, F_SETFD, FD_CLOEXEC)
				#if canImport(Darwin)
				var on: Int32 = 1
				setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
				#endif
				return fd
			}
			if errno == EINTR || errno == ECONNABORTED { continue }
			return nil
		}
	}

	/// Connects to path, waiting up to waitMs for a listener that is just starting.
	public static func connect(_ path: String, waitMs: Int = 3000) throws -> Int32 {
		let until = Date().addingTimeInterval(Double(waitMs) / 1000)
		while true {
			let fd = try socketFD()
			var addr = try address(path)
			let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { sysConnect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
			if rc == 0 { return fd }
			let code = errno
			sysClose(fd)
			if Date() >= until || (code != ENOENT && code != ECONNREFUSED) {
				throw RPCError.notFound("cannot reach Computerd at \(path): \(String(cString: strerror(code))). Is Computerd.app running?")
			}
			usleep(100_000)
		}
	}
}
