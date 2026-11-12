import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// tar.pull.* and tar.push.*: stream an archive out of or into a directory, through the system's tar. A connection
/// holds at most 8 of each open.
public actor TarSessions {
	static let maxOpen = 8
	var pulls: [String: Child] = [:]
	var pushes: [String: (child: Child, counter: TarCounter)] = [:]
	var next = 1
	let tar: String

	public init(tar: String = "/usr/bin/tar") {
		self.tar = tar
	}

	public func pullBegin(_ p: TarPathParams) throws -> TarIDResult {
		guard pulls.count < Self.maxOpen else { throw RPCError.limit("at most \(Self.maxOpen) pulls are open on a connection: end one first") }
		let path = try Files.clean("path", p.path)
		let info = try Files.describe(path, follow: true)
		let dir: String
		var names: [String]
		if info.type == .dir {
			dir = path
			names = ((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []).sorted()
		} else {
			dir = (path as NSString).deletingLastPathComponent
			names = [(path as NSString).lastPathComponent]
		}
		let id = "pull\(next)"
		next += 1
		if names.isEmpty {
			// An empty directory is an archive of two zero blocks; some tars refuse to write one.
			pulls[id] = Child.fixed(Data(count: 1024))
			return TarIDResult(id: id)
		}
		// The names go in on stdin, NUL-separated, from a thread of their own, so a long list never waits on the archive.
		let child = try Child.spawn([tar, "-C", dir, "--null", "-T", "-", "-cf", "-"], stdin: true, stdout: true)
		let list = Data((names.joined(separator: "\0") + "\0").utf8)
		Thread {
			_ = child.write(list)
			child.closeInput()
		}.start()
		pulls[id] = child
		return TarIDResult(id: id)
	}

	public func pullRead(_ p: TarPullReadParams) throws -> TarPullReadResult {
		guard let child = pulls[p.id] else { throw RPCError.notFound("no pull \(p.id) is open") }
		let max = p.maxBytes ?? Limits.maxChunkBytes
		guard max >= 1 else { throw RPCError.invalid("maxBytes must be 1 or more") }
		guard max <= Limits.maxChunkBytes else { throw RPCError.limit("a tar.pull.read returns at most \(Limits.maxChunkBytes) bytes") }
		let (data, eof) = child.read(max)
		if eof {
			pulls[p.id] = nil
			let (code, errors) = child.wait()
			if code != 0 { throw RPCError.invalid("tar failed: \(errors)") }
		}
		return TarPullReadResult(data: data, eof: eof)
	}

	public func pullEnd(_ p: TarIDParams) {
		pulls.removeValue(forKey: p.id)?.stop()
	}

	public func pushBegin(_ p: TarPathParams) throws -> TarIDResult {
		guard pushes.count < Self.maxOpen else { throw RPCError.limit("at most \(Self.maxOpen) pushes are open on a connection: end one first") }
		let path = try Files.clean("path", p.path)
		do {
			try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
		} catch {
			throw RPCError.denied("cannot make \(path): \(error.localizedDescription)")
		}
		let id = "push\(next)"
		next += 1
		pushes[id] = (try Child.spawn([tar, "-C", path, "-xf", "-"], stdin: true, stdout: false), TarCounter())
		return TarIDResult(id: id)
	}

	public func pushWrite(_ p: TarPushWriteParams) throws {
		guard var push = pushes[p.id] else { throw RPCError.notFound("no push \(p.id) is open") }
		push.counter.feed(p.data)
		pushes[p.id] = push
		guard push.child.write(p.data) else {
			pushes[p.id] = nil
			let (_, errors) = push.child.wait()
			throw RPCError.invalid("tar stopped reading: \(errors)")
		}
	}

	public func pushEnd(_ p: TarIDParams) throws -> TarPushEndResult {
		guard let push = pushes.removeValue(forKey: p.id) else { throw RPCError.notFound("no push \(p.id) is open") }
		push.child.closeInput()
		let (code, errors) = push.child.wait()
		if code != 0 { throw RPCError.invalid("tar failed: \(errors)") }
		return TarPushEndResult(entries: push.counter.entries)
	}

	public func closeAll() {
		for child in pulls.values { child.stop() }
		for push in pushes.values { push.child.stop() }
		pulls = [:]
		pushes = [:]
	}
}

/// Counts a tar stream's entries as it passes: each header block, less the extended headers that describe the next one.
struct TarCounter: Sendable {
	private(set) var entries = 0
	private var block = Data()
	private var skip = 0
	private var ended = false

	mutating func feed(_ data: Data) {
		var rest = data[...]
		while !rest.isEmpty && !ended {
			if skip > 0 {
				let n = min(skip, rest.count)
				skip -= n
				rest = rest.dropFirst(n)
				continue
			}
			let need = 512 - block.count
			block.append(rest.prefix(need))
			rest = rest.dropFirst(min(need, rest.count))
			if block.count < 512 { return }
			header(block)
			block = Data()
		}
	}

	private mutating func header(_ h: Data) {
		let bytes = [UInt8](h)
		if bytes.allSatisfy({ $0 == 0 }) {
			ended = true
			return
		}
		let sizeField = String(decoding: bytes[124..<136].prefix { $0 != 0 && $0 != 32 }, as: UTF8.self)
		let size = Int(sizeField, radix: 8) ?? 0
		skip = (size + 511) / 512 * 512
		let type = bytes[156]
		// pax ('x', 'g') and GNU long-name ('L', 'K') headers describe the entry that follows.
		if ![UInt8(ascii: "x"), UInt8(ascii: "g"), UInt8(ascii: "L"), UInt8(ascii: "K")].contains(type) { entries += 1 }
	}
}

/// A child process with pipes to its stdin or stdout, and its stderr kept for the words of a failure.
final class Child: @unchecked Sendable {
	let pid: pid_t
	let input: Int32
	let output: Int32
	let errors: Exec.Collector?
	let fixed: Data?
	var fixedOffset = 0

	init(pid: pid_t, input: Int32, output: Int32, errors: Exec.Collector?, fixed: Data? = nil) {
		self.pid = pid
		self.input = input
		self.output = output
		self.errors = errors
		self.fixed = fixed
	}

	static func fixed(_ data: Data) -> Child {
		Child(pid: 0, input: -1, output: -1, errors: nil, fixed: data)
	}

	static func spawn(_ argv: [String], stdin: Bool, stdout: Bool) throws -> Child {
		var inPipe: [Int32] = [-1, -1]
		var outPipe: [Int32] = [-1, -1]
		var errPipe: [Int32] = [0, 0]
		if stdin { guard pipe(&inPipe) == 0 else { throw RPCError.invalid("cannot make a pipe") } }
		if stdout { guard pipe(&outPipe) == 0 else { throw RPCError.invalid("cannot make a pipe") } }
		guard pipe(&errPipe) == 0 else { throw RPCError.invalid("cannot make a pipe") }
		var actions = posix_spawn_file_actions_t()
		posix_spawn_file_actions_init(&actions)
		defer { posix_spawn_file_actions_destroy(&actions) }
		if stdin { posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0) } else { posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0) }
		if stdout { posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1) } else { posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0) }
		posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)
		for fd in inPipe + outPipe + errPipe where fd >= 0 { posix_spawn_file_actions_addclose(&actions, fd) }
		var attr = posix_spawnattr_t()
		posix_spawnattr_init(&attr)
		defer { posix_spawnattr_destroy(&attr) }
		var flags = Int16(POSIX_SPAWN_SETPGROUP)
		#if canImport(Darwin)
		flags |= Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)
		#endif
		posix_spawnattr_setflags(&attr, flags)
		posix_spawnattr_setpgroup(&attr, 0)
		let args = argv.map { strdup($0) } + [nil]
		let fixedEnv: [String] = ["PATH=/usr/bin:/bin", "LC_ALL=C"]
		let env: [UnsafeMutablePointer<CChar>?] = fixedEnv.map { strdup($0) } + [nil]
		defer {
			for s in args { free(s) }
			for s in env { free(s) }
		}
		var pid: pid_t = 0
		let rc = posix_spawn(&pid, argv[0], &actions, &attr, args, env)
		if stdin { sysClose(inPipe[0]) }
		if stdout { sysClose(outPipe[1]) }
		sysClose(errPipe[1])
		guard rc == 0 else {
			for fd in [inPipe[1], outPipe[0], errPipe[0]] where fd >= 0 { sysClose(fd) }
			throw RPCError.invalid("cannot start \(argv[0]): \(String(cString: strerror(rc)))")
		}
		return Child(pid: pid, input: stdin ? inPipe[1] : -1, output: stdout ? outPipe[0] : -1, errors: Exec.Collector(fd: errPipe[0], limit: 4096))
	}

	/// Up to max bytes of stdout, waiting for them; eof once it ends.
	func read(_ max: Int) -> (Data, Bool) {
		if let fixed {
			let end = min(fixed.count, fixedOffset + max)
			let data = fixed.subdata(in: fixedOffset..<end)
			fixedOffset = end
			return (data, end == fixed.count)
		}
		var buffer = [UInt8](repeating: 0, count: max)
		var got = 0
		while got < max {
			let n = buffer.withUnsafeMutableBytes { sysRead(output, $0.baseAddress! + got, max - got) }
			if n < 0 && errno == EINTR { continue }
			if n <= 0 { return (Data(buffer[0..<got]), true) }
			got += n
		}
		return (Data(buffer), false)
	}

	func write(_ data: Data) -> Bool {
		FDOutput.writeAll(input, data)
	}

	let lock = NSLock()
	var inputClosed = false

	/// Closes stdin once, however many times it is asked.
	func closeInput() {
		lock.lock()
		defer { lock.unlock() }
		if input >= 0 && !inputClosed { sysClose(input) }
		inputClosed = true
	}

	/// Waits for the end: the exit code, and the start of what it said on stderr.
	func wait() -> (Int32, String) {
		guard fixed == nil else { return (0, "") }
		var status: Int32 = 0
		while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
		if output >= 0 { sysClose(output) }
		let said = errors.map { String(decoding: $0.finish().data, as: UTF8.self) } ?? ""
		let code: Int32 = status & 0x7f == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
		return (code, said.trimmingCharacters(in: .whitespacesAndNewlines))
	}

	func stop() {
		guard fixed == nil else { return }
		kill(-pid, SIGKILL)
		closeInput()
		_ = wait()
	}
}
