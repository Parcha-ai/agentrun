package isolate

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	prSetChildSubreaper  = 36
	prCapAmbient         = 47
	prCapAmbientClearAll = 4
	capVersion3          = 0x20080522
)

// BecomeSubreaper makes this process the reaper of its descendants' orphans (PR_SET_CHILD_SUBREAPER, kept across exec).
func BecomeSubreaper() error {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		return errno
	}
	return nil
}

type capHeader struct {
	version uint32
	pid     int32
}

// CapData is one word of a thread's effective, permitted and inheritable sets, as linux/capability.h has it (version 3:
// two 32-bit words a set).
type CapData struct{ Effective, Permitted, Inheritable uint32 }

// The capset arguments live outside any goroutine's stack, which may move while AllThreadsSyscall runs.
var (
	capsetHeader = capHeader{version: capVersion3}
	capsetData   [2]CapData
)

// ClearCapabilities empties every thread's ambient, effective, permitted and inheritable sets. Dropping a capability
// needs none. A kernel with no ambient set answers EINVAL to it, and has nothing there to empty.
func ClearCapabilities() error {
	if _, _, errno := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClearAll, 0, 0, 0, 0); errno != 0 && errno != syscall.EINVAL {
		return fmt.Errorf("cannot empty the ambient capability set of every thread: %w", errno)
	}
	capsetData = [2]CapData{}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&capsetHeader)), uintptr(unsafe.Pointer(&capsetData[0])), 0); errno != 0 {
		return fmt.Errorf("cannot empty the capability sets of every thread: %w", errno)
	}
	return nil
}

// ThreadCapabilities reads thread tid's effective, permitted and inheritable sets (capget). A thread that is gone is
// syscall.ESRCH.
func ThreadCapabilities(tid int) ([2]CapData, error) {
	header := capHeader{version: capVersion3, pid: int32(tid)}
	var data [2]CapData
	if _, _, errno := syscall.RawSyscall(syscall.SYS_CAPGET, uintptr(unsafe.Pointer(&header)), uintptr(unsafe.Pointer(&data[0])), 0); errno != 0 {
		return data, errno
	}
	return data, nil
}
