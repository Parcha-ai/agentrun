// Package isolate cuts the programs of a remote computer off from what else runs in it. A remote vendor's own agent
// runs in the computer beside them (Daytona's toolbox, E2B's envd) and runs commands as root, or as a user with sudo, for
// whoever reaches it, on the computer's loopback and on every other address it has. So init, while it is still root,
// moves itself into a network namespace that holds its own loopback alone (OwnNetwork), refuses to start while another
// process holds the uid its programs run as (RefuseStrangers), and, once it has dropped, takes vsock and io_uring from
// every thread (DenySockets). Every program init starts inherits all three.
package isolate

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	threadNetwork = "/proc/thread-self/ns/net"
	siocgifflags  = 0x8913
	siocsifflags  = 0x8914
	ifNameSize    = 16
)

// OwnNetwork moves every thread of this process into a new network namespace and brings its loopback up, so this
// process and every program it starts reach their own loopback and nothing else: no address of the computer's, no
// listener on its loopback, no abstract unix socket outside. A unix socket with a path is not in a network namespace, so
// a bridge outside still reaches init's socket. It needs root with CAP_SYS_ADMIN (to make the namespace and move every
// thread into it) and CAP_NET_ADMIN (to bring the loopback up), and it reads back that every thread left the namespace
// it started in and that the new one holds the loopback alone, up. Any failure is an error in words, and init refuses to
// start: a computer whose programs could reach the vendor's agent is never handed out.
func OwnNetwork() error {
	first, err := os.Readlink(threadNetwork)
	if err != nil {
		return fmt.Errorf("cannot read init's network namespace, so cannot give its programs one of their own: %w", err)
	}
	// Made on one thread, which is in it from then on; every other thread joins it by its file.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := syscall.Unshare(syscall.CLONE_NEWNET); err != nil {
		return fmt.Errorf("cannot make a network namespace of its own for init and its programs: %w; init needs root with CAP_SYS_ADMIN here, and a computer without one is refused, since its programs could reach the vendor's agent on the computer's loopback", err)
	}
	fd, err := syscall.Open(threadNetwork, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("cannot open the new network namespace to move init's other threads into it: %w", err)
	}
	_, _, errno := syscall.AllThreadsSyscall(sysSetns, uintptr(fd), syscall.CLONE_NEWNET, 0)
	syscall.Close(fd)
	if errno != 0 {
		return fmt.Errorf("cannot move every thread of init into its own network namespace (CAP_SYS_ADMIN): %w", errno)
	}
	if err := loopbackUp(); err != nil {
		return err
	}
	return checkOwnNetwork(first)
}

// loopbackUp brings up the loopback of the network namespace this thread is in: a new one starts with it down.
func loopbackUp() error {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("cannot open a socket to bring the new network namespace's loopback up: %w", err)
	}
	defer syscall.Close(fd)
	// struct ifreq: the name, then a union whose first member here is the flags, a short.
	var req [40]byte
	copy(req[:ifNameSize-1], "lo")
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), siocgifflags, uintptr(unsafe.Pointer(&req[0]))); errno != 0 {
		return fmt.Errorf("cannot read the flags of the new network namespace's loopback: %w", errno)
	}
	*(*uint16)(unsafe.Pointer(&req[ifNameSize])) |= syscall.IFF_UP
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), siocsifflags, uintptr(unsafe.Pointer(&req[0]))); errno != 0 {
		return fmt.Errorf("cannot bring the new network namespace's loopback up: %w; init needs CAP_NET_ADMIN here", errno)
	}
	return nil
}

// checkOwnNetwork reads back what OwnNetwork set: every thread in one network namespace, not first, and that namespace's
// interfaces the loopback alone, up.
func checkOwnNetwork(first string) error {
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return fmt.Errorf("cannot list init's threads to read their network namespace back: %w", err)
	}
	for _, task := range tasks {
		link, err := os.Readlink(filepath.Join("/proc/self/task", task.Name(), "ns", "net"))
		if errors.Is(err, fs.ErrNotExist) {
			continue // a thread that ended
		}
		if err != nil {
			return fmt.Errorf("cannot read thread %s's network namespace back: %w", task.Name(), err)
		}
		if link == first {
			return fmt.Errorf("thread %s is still in the network namespace init started in (%s) after every thread was moved", task.Name(), link)
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return fmt.Errorf("cannot list the new network namespace's interfaces to read it back: %w", err)
	}
	names := make([]string, 0, len(ifaces))
	for _, iface := range ifaces {
		names = append(names, iface.Name)
	}
	if len(ifaces) != 1 || ifaces[0].Flags&net.FlagLoopback == 0 || ifaces[0].Flags&net.FlagUp == 0 {
		return fmt.Errorf("the new network namespace reads back interfaces %s, not the loopback alone, up", strings.Join(names, ", "))
	}
	return nil
}

// Stranger is another process that holds the uid init's programs run as.
type Stranger struct {
	PID  int
	Name string
}

// Strangers lists the processes under proc (a /proc) other than self whose real, effective, saved or filesystem uid is
// uid, by pid. A process that ends while it is read is left out.
func Strangers(proc string, uid, self int) ([]Stranger, error) {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return nil, fmt.Errorf("cannot list the computer's processes in %s: %w", proc, err)
	}
	found := []Stranger{}
	want := strconv.Itoa(uid)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == self || !entry.IsDir() {
			continue
		}
		status, err := os.ReadFile(filepath.Join(proc, entry.Name(), "status"))
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("cannot read process %d's status: %w", pid, err)
		}
		name, holds := "", false
		for line := range strings.Lines(string(status)) {
			if value, ok := strings.CutPrefix(line, "Name:"); ok {
				name = strings.TrimSpace(value)
			}
			if value, ok := strings.CutPrefix(line, "Uid:"); ok {
				for _, id := range strings.Fields(value) {
					holds = holds || id == want
				}
			}
		}
		if holds {
			found = append(found, Stranger{PID: pid, Name: name})
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].PID < found[j].PID })
	return found, nil
}

// RefuseStrangers refuses, in words, when a process other than self holds uid. Run by init as root before it starts any
// program, when every other process in the computer is the vendor's or the image's: one that holds the uid init's
// programs run as could be signalled or traced by them, or read and write what they write, and a vendor's agent among
// them would be theirs to command.
func RefuseStrangers(proc string, uid, self int) error {
	found, err := Strangers(proc, uid, self)
	if err != nil {
		return err
	}
	if len(found) == 0 {
		return nil
	}
	named := make([]string, 0, len(found))
	for _, one := range found {
		named = append(named, fmt.Sprintf("%d (%s)", one.PID, one.Name))
	}
	return fmt.Errorf("uid %d, which init's programs run as, is held already by process %s outside init: they could signal, trace or command it; give the computer's programs a uid of their own", uid, strings.Join(named, ", "))
}
