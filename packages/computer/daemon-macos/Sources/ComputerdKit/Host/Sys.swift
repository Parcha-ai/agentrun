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
