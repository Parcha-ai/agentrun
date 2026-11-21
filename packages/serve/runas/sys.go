//go:build linux

package main

import (
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// sys is every privileged or process-level call, so tests can record them.
type sys interface {
	Setgroups(gids []int) error
	Setresgid(r, e, s int) error
	Setresuid(r, e, s int) error
	CapLastCap() (int, error)
	CapbsetDrop(c int) error
	AmbientClearAll() error
	CapsetZero() error
	CapsetOnly(mask uint64) error
	SetNoNewPrivs() error
	SetPdeathsig() error
	Getppid() int
	Umask(mask int) int
	ReadStatus() (string, error)
	ListFds() ([]int, error)
	CloseFd(fd int) error
	Exec(program string, argv, env []string) error
	Kill(pid int, sig syscall.Signal) error
	LiveProcs(uid int) (int, error)
	Sleep(d time.Duration)
	Getuid() int
	Own(dir string, owned func(int) bool, runner, uid, gid int, stderr io.Writer) bool
}

const (
	prSetPdeathsig       = 1
	prCapbsetDrop        = 24
	prSetNoNewPrivs      = 38
	prCapAmbient         = 47
	prCapAmbientClearAll = 4

	linuxCapabilityVersion3 = 0x20080522
)

type capHeader struct {
	version uint32
	pid     int32
}

type capData struct {
	effective, permitted, inheritable uint32
}

// realSys is the Linux implementation. Reads before exec use raw syscalls,
// not package os, so closing fds never pulls a descriptor from under the
// runtime's poller.
type realSys struct{}

func prctl(op, a2, a3, a4, a5 uintptr) error {
	_, _, e := syscall.RawSyscall6(syscall.SYS_PRCTL, op, a2, a3, a4, a5, 0)
	if e != 0 {
		return e
	}
	return nil
}

func (realSys) Setgroups(gids []int) error  { return syscall.Setgroups(gids) }
func (realSys) Setresgid(r, e, s int) error { return syscall.Setresgid(r, e, s) }
func (realSys) Setresuid(r, e, s int) error { return syscall.Setresuid(r, e, s) }

func (realSys) CapLastCap() (int, error) {
	b, err := readRaw("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(b)))
}

func (realSys) CapbsetDrop(c int) error { return prctl(prCapbsetDrop, uintptr(c), 0, 0, 0) }

func (realSys) AmbientClearAll() error {
	return prctl(prCapAmbient, prCapAmbientClearAll, 0, 0, 0)
}

func (realSys) CapsetZero() error {
	hdr := capHeader{version: linuxCapabilityVersion3}
	var data [2]capData
	_, _, e := syscall.RawSyscall(syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0)
	if e != 0 {
		return e
	}
	return nil
}

// CapsetOnly leaves exactly mask in the effective and permitted sets and
// none inheritable: what the thread may keep, never what it may gain.
func (realSys) CapsetOnly(mask uint64) error {
	hdr := capHeader{version: linuxCapabilityVersion3}
	data := [2]capData{
		{effective: uint32(mask), permitted: uint32(mask)},
		{effective: uint32(mask >> 32), permitted: uint32(mask >> 32)},
	}
	_, _, e := syscall.RawSyscall(syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0)
	if e != 0 {
		return e
	}
	return nil
}

func (realSys) SetNoNewPrivs() error { return prctl(prSetNoNewPrivs, 1, 0, 0, 0) }

func (realSys) SetPdeathsig() error {
	return prctl(prSetPdeathsig, uintptr(syscall.SIGKILL), 0, 0, 0)
}

func (realSys) Getppid() int         { return syscall.Getppid() }
func (realSys) Umask(mask int) int   { return syscall.Umask(mask) }
func (realSys) CloseFd(fd int) error { return syscall.Close(fd) }

// ReadStatus reads the calling thread's status: credentials and
// capabilities are per thread.
func (realSys) ReadStatus() (string, error) {
	b, err := readRaw("/proc/thread-self/status")
	return string(b), err
}

func (realSys) ListFds() ([]int, error) {
	dir, err := openRetry("/proc/self/fd", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(dir)
	buf := make([]byte, 8192)
	var names []string
	for {
		n, err := syscall.ReadDirent(dir, buf)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return nil, err
		}
		if n <= 0 {
			break
		}
		_, _, names = syscall.ParseDirent(buf[:n], -1, names)
	}
	var fds []int
	for _, name := range names {
		fd, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		if fd != dir {
			fds = append(fds, fd)
		}
	}
	return fds, nil
}

func (realSys) Exec(program string, argv, env []string) error {
	return syscall.Exec(program, argv, env)
}

func (realSys) Kill(pid int, sig syscall.Signal) error { return syscall.Kill(pid, sig) }

func (realSys) LiveProcs(uid int) (int, error) {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	self := os.Getpid()
	n := 0
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/status")
		if err != nil {
			continue // gone
		}
		if procAlive(string(b), uid) {
			n++
		}
	}
	return n, nil
}

func (realSys) Sleep(d time.Duration) { time.Sleep(d) }

func (realSys) Getuid() int { return syscall.Getuid() }

func (realSys) Own(dir string, owned func(int) bool, runner, uid, gid int, stderr io.Writer) bool {
	return ownDir(dir, owned, runner, uid, gid, stderr)
}

func openRetry(path string, flags int) (int, error) {
	for {
		fd, err := syscall.Open(path, flags, 0)
		if err != syscall.EINTR {
			return fd, err
		}
	}
}

func readRaw(path string) ([]byte, error) {
	fd, err := openRetry(path, syscall.O_RDONLY|syscall.O_CLOEXEC)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)
	var out []byte
	buf := make([]byte, 4096)
	for {
		n, err := syscall.Read(fd, buf)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return nil, err
		}
		if n <= 0 {
			return out, nil
		}
		out = append(out, buf[:n]...)
	}
}
