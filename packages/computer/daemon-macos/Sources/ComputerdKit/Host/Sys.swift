#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// The C calls the host methods use, by names no Swift type shadows.

func sysRead(_ fd: Int32, _ buffer: UnsafeMutableRawPointer?, _ count: Int) -> Int { read(fd, buffer, count) }
func sysWrite(_ fd: Int32, _ buffer: UnsafeRawPointer?, _ count: Int) -> Int { write(fd, buffer, count) }
func sysMkdir(_ path: String, _ mode: mode_t) -> Int32 { mkdir(path, mode) }
func sysStat(_ path: String, _ st: inout stat) -> Int32 { stat(path, &st) }
func sysLstat(_ path: String, _ st: inout stat) -> Int32 { lstat(path, &st) }
func sysClose(_ fd: Int32) { _ = close(fd) }
func sysListen(_ fd: Int32, _ backlog: Int32) -> Int32 { listen(fd, backlog) }
func sysAccept(_ fd: Int32) -> Int32 { accept(fd, nil, nil) }
func sysConnect(_ fd: Int32, _ addr: UnsafePointer<sockaddr>, _ len: socklen_t) -> Int32 { connect(fd, addr, len) }

/// A pipe whose write end fails with EPIPE once its reader is gone, never with SIGPIPE: the driver writes into child
/// processes that can quit early (tar on a stream that is no archive), and the signal would kill the whole process,
/// the daemon or a test runner alike. Every pipe the driver makes comes from here. 0, or -1 with errno set.
func sysPipe(_ fds: inout [Int32]) -> Int32 {
	guard pipe(&fds) == 0 else { return -1 }
	#if canImport(Darwin)
	_ = fcntl(fds[1], F_SETNOSIGPIPE, 1)
	#else
	// Linux has no switch on a pipe's descriptor (MSG_NOSIGNAL is for sockets): the process ignores SIGPIPE, once.
	_ = ignoreSigPipe
	#endif
	return 0
}

#if !canImport(Darwin)
private let ignoreSigPipe: Void = { _ = signal(SIGPIPE, SIG_IGN) }()
#endif
