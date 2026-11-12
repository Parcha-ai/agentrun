import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// exec.run: one program from argv (never a shell) to its end, as the logged-in user, in a process group of its own.
/// On a timeout or a cancel the group gets SIGTERM, then SIGKILL 2 s later; when the program ends, whatever it left in
/// its group is killed, so nothing a run starts outlives it.
public enum Exec {
	static let killGrace: Double = 2000

	// posix_spawn's opaque types: Darwin's calls take an optional pointer, Glibc's a struct. Each starts empty, for its
	// init call.
	#if canImport(Darwin)
	typealias SpawnActions = posix_spawn_file_actions_t?
	typealias SpawnAttr = posix_spawnattr_t?
	static func blankActions() -> SpawnActions { nil }
	static func blankAttr() -> SpawnAttr { nil }
	#else
	typealias SpawnActions = posix_spawn_file_actions_t
	typealias SpawnAttr = posix_spawnattr_t
	static func blankActions() -> SpawnActions { posix_spawn_file_actions_t() }
	static func blankAttr() -> SpawnAttr { posix_spawnattr_t() }
	#endif

	public static func run(_ p: ExecRunParams, clock: any Clock = SystemClock()) async throws -> ExecRunResult {
		guard let program = p.argv.first, !program.isEmpty else { throw RPCError.invalid("argv needs at least a program") }
		guard p.timeoutMs > 0 else { throw RPCError.invalid("the timeout must be positive") }
		let limit = p.maxOutput ?? Limits.maxOutputBytes
		guard limit >= 0, limit <= Limits.maxOutputBytes else {
			throw RPCError.invalid("maxOutput must be from 0 to \(Limits.maxOutputBytes)")
		}
		if let user = p.user, user != currentUser(), user != String(getuid()) {
			throw RPCError.denied("Computerd runs programs as the logged-in user (\(currentUser())) only, not \(user)")
		}
		let env = environment(p.env)
		let cwd = p.cwd.map { $0.hasPrefix("/") ? $0 : home() + "/" + $0 }
		let path = try lookPath(program, path: env["PATH"] ?? "", cwd: cwd)
		let deadline = clock.now() + Double(p.timeoutMs)

		var outPipe: [Int32] = [0, 0]
		var errPipe: [Int32] = [0, 0]
		guard pipe(&outPipe) == 0, pipe(&errPipe) == 0 else { throw RPCError.invalid("cannot make a pipe: \(String(cString: strerror(errno)))") }

		var actions = blankActions()
		posix_spawn_file_actions_init(&actions)
		defer { posix_spawn_file_actions_destroy(&actions) }
		posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
		posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
		posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)
		for fd in outPipe + errPipe { posix_spawn_file_actions_addclose(&actions, fd) }
		if let cwd { posix_spawn_file_actions_addchdir_np(&actions, cwd) }

		var attr = blankAttr()
		posix_spawnattr_init(&attr)
		defer { posix_spawnattr_destroy(&attr) }
		posix_spawnattr_setpgroup(&attr, 0)
		var flags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
		#if canImport(Darwin)
		// Only the descriptors the actions made reach the program: never the driver's sockets.
		flags |= Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)
		#endif
		posix_spawnattr_setflags(&attr, flags)
		var all = sigset_t()
		sigfillset(&all)
		posix_spawnattr_setsigdefault(&attr, &all)
		var none = sigset_t()
		sigemptyset(&none)
		posix_spawnattr_setsigmask(&attr, &none)

		let argv = p.argv.map { strdup($0) } + [nil]
		let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
		defer {
			for s in argv { free(s) }
			for s in envp { free(s) }
		}
		var pid: pid_t = 0
		let rc = posix_spawn(&pid, path, &actions, &attr, argv, envp)
		close(outPipe[1])
		close(errPipe[1])
		guard rc == 0 else {
			close(outPipe[0])
			close(errPipe[0])
			let kind: ErrorKind = rc == ENOENT ? .notFound : rc == EACCES ? .denied : .invalid
			throw RPCError(kind, "cannot start \(program): \(String(cString: strerror(rc)))")
		}

		let stdout = Collector(fd: outPipe[0], limit: limit)
		let stderr = Collector(fd: errPipe[0], limit: limit)
		var status: Int32 = 0
		var timedOut = false
		var cancelled = false
		var termAt: Double?
		while true {
			let r = waitpid(pid, &status, WNOHANG)
			if r == pid { break }
			if r < 0 && errno != EINTR { break }
			let now = clock.now()
			if termAt == nil && (Task.isCancelled || now >= deadline) {
				cancelled = Task.isCancelled
				timedOut = !cancelled
				kill(-pid, SIGTERM)
				termAt = now
			} else if let at = termAt, now - at >= killGrace {
				kill(-pid, SIGKILL)
			}
			try? await Task.sleep(nanoseconds: 5_000_000)
		}
		// What the program left in its group goes with it.
		kill(-pid, SIGKILL)
		let out = stdout.finish()
		let err = stderr.finish()
		if cancelled { throw RPCError.aborted }
		let (exitCode, signal) = decode(status)
		return ExecRunResult(exitCode: exitCode, signal: signal, stdout: out.data, stderr: err.data, timedOut: timedOut, truncated: out.truncated || err.truncated)
	}

	static func decode(_ status: Int32) -> (Int?, String?) {
		let low = status & 0x7f
		if low == 0 { return (Int((status >> 8) & 0xff), nil) }
		return (nil, signalName(low))
	}

	static func signalName(_ signal: Int32) -> String {
		let names: [Int32: String] = [SIGHUP: "HUP", SIGINT: "INT", SIGQUIT: "QUIT", SIGILL: "ILL", SIGABRT: "ABRT", SIGKILL: "KILL", SIGSEGV: "SEGV", SIGPIPE: "PIPE", SIGALRM: "ALRM", SIGTERM: "TERM", SIGBUS: "BUS", SIGUSR1: "USR1", SIGUSR2: "USR2"]
		return names[signal] ?? String(signal)
	}

	/// PATH, HOME, USER and LOGNAME for the logged-in user, then the caller's env over them. Nothing else of the
	/// driver's own environment is passed.
	static func environment(_ given: [String: String]?) -> [String: String] {
		let inherited = ProcessInfo.processInfo.environment["PATH"] ?? ""
		var vars = [
			"PATH": inherited.isEmpty ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" : inherited,
			"HOME": home(),
			"USER": currentUser(),
			"LOGNAME": currentUser(),
		]
		for (key, value) in given ?? [:] { vars[key] = value }
		return vars
	}

	static func home() -> String {
		if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
		return ProcessInfo.processInfo.environment["HOME"] ?? "/"
	}

	static func currentUser() -> String {
		if let pw = getpwuid(getuid()), let name = pw.pointee.pw_name { return String(cString: name) }
		return String(getuid())
	}

	/// argv[0] on the PATH the program gets, not the driver's. A name with a slash is taken as it is, relative to cwd.
	static func lookPath(_ program: String, path: String, cwd: String?) throws -> String {
		if program.contains("/") {
			return program.hasPrefix("/") || cwd == nil ? program : cwd! + "/" + program
		}
		for dir in path.split(separator: ":", omittingEmptySubsequences: false) {
			let base = dir.isEmpty ? (cwd ?? ".") : String(dir)
			let candidate = base + "/" + program
			var st = stat()
			if sysStat(candidate, &st) == 0, st.st_mode & S_IFMT == S_IFREG, access(candidate, X_OK) == 0 {
				return candidate
			}
		}
		throw RPCError.notFound("no program \(program) on the PATH \(path)")
	}

	/// Reads a pipe to its end on a thread of its own, keeping the first limit bytes and dropping the rest.
	final class Collector: @unchecked Sendable {
		let done = DispatchSemaphore(value: 0)
		let lock = NSLock()
		var data = Data()
		var truncated = false

		init(fd: Int32, limit: Int) {
			let thread = Thread { [self] in
				var buffer = [UInt8](repeating: 0, count: 64 * 1024)
				while true {
					let n = buffer.withUnsafeMutableBytes { sysRead(fd, $0.baseAddress, $0.count) }
					if n < 0 && errno == EINTR { continue }
					if n <= 0 { break }
					lock.lock()
					let room = limit - data.count
					if room > 0 { data.append(contentsOf: buffer[0..<min(n, room)]) }
					if n > room { truncated = true }
					lock.unlock()
				}
				sysClose(fd)
				done.signal()
			}
			thread.start()
		}

		/// The output once the pipe ends; a program that left its pipe open elsewhere gets 2 s, then what came.
		func finish() -> (data: Data, truncated: Bool) {
			_ = done.wait(timeout: .now() + 2)
			lock.lock()
			defer { lock.unlock() }
			return (data, truncated)
		}
	}
}
