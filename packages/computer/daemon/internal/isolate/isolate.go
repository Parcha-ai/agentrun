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
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/netstate"
)

// ErrNoNetworkNamespace is OwnNetwork's refusal when root may not make a network namespace itself (EPERM, no
// CAP_SYS_ADMIN): its words say so, and init makes the namespace inside a user namespace instead.
var ErrNoNetworkNamespace = errors.New("cannot make a network namespace of its own for init and its programs: root here holds no CAP_SYS_ADMIN")

const threadNetwork = "/proc/thread-self/ns/net"

// OwnNetwork moves every thread of this process into a new network namespace and brings its loopback up, so this
// process and every program it starts reach their own loopback and nothing else: no address of the computer's, no
// listener on its loopback, no abstract unix socket outside. A unix socket with a path is not in a network namespace, so
// a bridge outside still reaches init's socket. It needs root with CAP_SYS_ADMIN (to make the namespace and move every
// thread into it) and CAP_NET_ADMIN (to bring the loopback up), and it reads back that every thread left the namespace
// it started in and that the new one holds the loopback alone, up. Any failure is an error in words, and init refuses to
// start: a computer whose programs could reach the vendor's agent is never handed out. A root refused the namespace
// itself (EPERM: no CAP_SYS_ADMIN, as on gVisor) gets an error that is ErrNoNetworkNamespace, for init to make it inside
// a user namespace instead (daemon.InitInUserNamespace); nothing has changed then.
func OwnNetwork() error {
	first, err := os.Readlink(threadNetwork)
	if err != nil {
		return fmt.Errorf("cannot read init's network namespace, so cannot give its programs one of their own: %w", err)
	}
	// Made on one thread, which is in it from then on; every other thread joins it by its file.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := syscall.Unshare(syscall.CLONE_NEWNET); errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("%w: %w", ErrNoNetworkNamespace, err)
	} else if err != nil {
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

// KeepOwnNetwork is OwnNetwork for an init that was started in a network namespace of its own: made, with a user
// namespace around it, by the init that started it (daemon.InitInUserNamespace), where root may make a user namespace
// but not a network namespace (gVisor on Modal: unshare(CLONE_NEWNET) is EPERM without CAP_SYS_ADMIN). first is the
// network namespace that init was in. It brings the loopback up, as root of the user namespace that owns the network
// namespace, and reads back what OwnNetwork reads: no thread in first, and the loopback alone up or addressed. Any
// failure is an error in words, and init refuses to start.
func KeepOwnNetwork(first string) error {
	if first == "" {
		return fmt.Errorf("the network namespace init was started from is not named, so its own cannot be read back as another")
	}
	// Before anything is touched: an init still in first was not started in a namespace of its own.
	if err := threadsLeft(first); err != nil {
		return err
	}
	if err := loopbackUp(); err != nil {
		return err
	}
	return checkOwnNetwork(first)
}

// loopbackUp brings up the loopback of the network namespace this process is in, over rtnetlink, and reads it back:
// a new one starts with it down (netstate.LoopbackUp).
func loopbackUp() error {
	return netstate.LoopbackUp()
}

// checkOwnNetwork reads back what OwnNetwork set: every thread in one network namespace, not first, and in that
// namespace the loopback alone up or addressed (netstate.OwnProblem): a kernel's fallback tunnels, down with no address,
// are there on some kernels (Modal's), and no program of init's can raise them, holding no CAP_NET_ADMIN.
func checkOwnNetwork(first string) error {
	if err := threadsLeft(first); err != nil {
		return err
	}
	ifaces, err := netstate.Read()
	if err != nil {
		return fmt.Errorf("cannot read the new network namespace back: %w", err)
	}
	if problem := netstate.OwnProblem(ifaces); problem != "" {
		return fmt.Errorf("init's own network does not keep to its loopback: %s", problem)
	}
	return nil
}

// threadsLeft reads back that no thread of this process is in the network namespace first.
func threadsLeft(first string) error {
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
			return fmt.Errorf("thread %s is still in the network namespace init started in (%s), not in one of its own", task.Name(), link)
		}
	}
	return nil
}

// SystemSockets is where a vendor's base leaves the system's unix sockets (rpcbind, sshd's unix-local socket,
// systemd's varlink sockets, some PID 1's own, the journal's stdout socket).
const SystemSockets = "/run"

// CloseSystemSockets takes others' access off every unix socket under root that others may write, links never
// followed: connecting to a path socket takes write on it, and a network namespace does not cut one, so a program of
// another uid reaches none of them. The owner's and group's access stays, so root and the services keep theirs; the
// computer's own sockets are not world-writable (the Archil sync socket is root:2510, computerd's lives in the programs'
// own folder). An unreadable folder is skipped, as a program could not reach in either; a chmod that fails is an error.
func CloseSystemSockets(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.Type()&fs.ModeSocket == 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Mode().Perm()&0o002 == 0 {
			return nil
		}
		if err := os.Chmod(path, info.Mode().Perm()&^0o007); err != nil {
			return fmt.Errorf("cannot take others' access off the socket %s, which init's programs could then reach: %w", path, err)
		}
		return nil
	})
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
