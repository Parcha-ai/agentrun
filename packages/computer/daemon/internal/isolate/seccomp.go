package isolate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// The classic BPF a seccomp filter is written in, and what it reads (uapi/linux/filter.h, uapi/linux/seccomp.h).
const (
	bpfLdWAbs = 0x20 // BPF_LD | BPF_W | BPF_ABS
	bpfJeqK   = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
	bpfJgeK   = 0x35 // BPF_JMP | BPF_JGE | BPF_K
	bpfRetK   = 0x06 // BPF_RET | BPF_K

	seccompSetModeFilter = 1
	seccompFlagTsync     = 1
	seccompRetAllow      = 0x7fff0000
	seccompRetErrno      = 0x00050000

	// seccomp_data: the call's number, its architecture, then its arguments, each 64 bits (the low half first on these
	// little-endian architectures).
	offsetNr   = 0
	offsetArch = 4
	offsetArg0 = 16

	x32Bit  = 0x40000000
	afVsock = 40
)

type sockFilter struct {
	code uint16
	jt   uint8
	jf   uint8
	k    uint32
}

type sockFprog struct {
	len    uint16
	filter *sockFilter
}

// The filter lives outside any goroutine's stack, which may move during the call.
var (
	filterProgram []sockFilter
	filterHeader  sockFprog
)

// program is the filter: a call of another architecture (32-bit x86 on amd64), or of the x32 table, meets ENOSYS; a
// socket of family AF_VSOCK, and io_uring_setup, meet EPERM; everything else is allowed.
func program() []sockFilter {
	p := []sockFilter{
		{bpfLdWAbs, 0, 0, offsetArch},
		{bpfJeqK, 1, 0, auditArch},
		{bpfRetK, 0, 0, seccompRetErrno | uint32(syscall.ENOSYS)},
		{bpfLdWAbs, 0, 0, offsetNr},
	}
	if x32 {
		p = append(p, sockFilter{bpfJgeK, 0, 1, x32Bit}, sockFilter{bpfRetK, 0, 0, seccompRetErrno | uint32(syscall.ENOSYS)})
	}
	return append(p,
		sockFilter{bpfJeqK, 0, 2, sysSocket},
		sockFilter{bpfLdWAbs, 0, 0, offsetArg0},
		sockFilter{bpfJeqK, 1, 2, afVsock},
		sockFilter{bpfJeqK, 0, 1, sysIOURingSetup},
		sockFilter{bpfRetK, 0, 0, seccompRetErrno | uint32(syscall.EPERM)},
		sockFilter{bpfRetK, 0, 0, seccompRetAllow},
	)
}

// DenySockets installs a seccomp filter on every thread of this process, inherited by every program it starts, that
// refuses (EPERM) a socket of family AF_VSOCK, which no network namespace cuts and where a virtual machine's agent may
// listen, and io_uring_setup, whose rings open sockets past any filter on socket(2). A call of another architecture or
// table (32-bit x86, x32) meets ENOSYS, so it cannot open what the native call may not. It needs no_new_privs set on
// every thread first (Become sets it) and reads back a filter on every thread.
func DenySockets() error {
	filterProgram = program()
	filterHeader = sockFprog{len: uint16(len(filterProgram)), filter: &filterProgram[0]}
	r, _, errno := syscall.Syscall(sysSeccomp, seccompSetModeFilter, seccompFlagTsync, uintptr(unsafe.Pointer(&filterHeader)))
	if errno != 0 {
		return fmt.Errorf("cannot install the filter that refuses vsock and io_uring: %w", errno)
	}
	if r != 0 {
		return fmt.Errorf("cannot install the filter that refuses vsock and io_uring on thread %d", r)
	}
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return fmt.Errorf("cannot list init's threads to read their filter back: %w", err)
	}
	for _, task := range tasks {
		status, err := os.ReadFile(filepath.Join("/proc/self/task", task.Name(), "status"))
		if err != nil {
			continue // a thread that ended
		}
		mode := "missing"
		for line := range strings.Lines(string(status)) {
			if value, found := strings.CutPrefix(line, "Seccomp:"); found {
				mode = strings.TrimSpace(value)
			}
		}
		if mode != "2" {
			return fmt.Errorf("thread %s reads seccomp mode %s after the filter was installed, not 2", task.Name(), mode)
		}
	}
	return nil
}
