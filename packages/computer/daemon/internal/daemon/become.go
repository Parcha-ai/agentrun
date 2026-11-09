package daemon

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/isolate"
)

const (
	prCapbsetRead        = 23
	prCapbsetDrop        = 24
	prSetNoNewPrivs      = 38
	prGetNoNewPrivs      = 39
	prCapAmbient         = 47
	prCapAmbientIsSet    = 1
	prCapAmbientClearAll = 4
	capVersion3          = 0x20080522
	capLastCapFile       = "/proc/sys/kernel/cap_last_cap"
)

// Become is init's start on a vendor that runs every computer as root and has no user of its own to give (Modal: "Modal
// containers always run as root (uid 0)", its USER is ignored), or whose image's privilege tools cannot be relied on
// (Daytona: the default snapshot's setpriv is BusyBox's). As root it makes HOME and the socket's directory
// uid:gid's alone (0700), then drops its privileges as Unprivileged does, becoming uid:gid with no supplementary groups
// on the way. Root included: a uid of 0 keeps every capability through the uid change, so the sets are emptied as well.
// It must run before Init. With isolation, see Isolation.
func Become(uid, gid int, home, socket string, isolation Isolation) error {
	if !filepath.IsAbs(home) {
		return fmt.Errorf("--user needs HOME to be an absolute path, the computer's user's own; it is %q", home)
	}
	if isolation.OwnNetwork && uid == 0 {
		return fmt.Errorf("--own-network refuses uid 0 for init's programs: root shares its uid with every root process of the vendor's, its agent among them; give them a uid of their own")
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("--user needs init to start as root, to give HOME and %s to uid %d and then become it; it runs as uid %d, so the provider gives the user itself (Docker: --user)", filepath.Dir(socket), uid, os.Geteuid())
	}
	if isolation.OwnNetwork {
		if err := isolate.RefuseStrangers(procRoot, uid, os.Getpid()); err != nil {
			return err
		}
	}
	for _, dir := range []string{home, filepath.Dir(socket)} {
		if err := prepareDir(dir, uid, gid); err != nil {
			return err
		}
	}
	if isolation.OwnNetwork {
		if err := isolate.OwnNetwork(); err != nil {
			return err
		}
		// No socket of the system's is the programs' to reach, since their own network does not cut a path socket.
		if err := isolate.CloseSystemSockets(isolate.SystemSockets); err != nil {
			return err
		}
	}
	if err := dropPrivileges(becomeUser(uid, gid)); err != nil {
		return err
	}
	if isolation.OwnNetwork {
		return isolate.DenySockets()
	}
	return nil
}

// Isolation is what init, still root, does beyond the drop, for a remote computer whose vendor runs its own agent in it
// (Daytona's toolbox, E2B's envd), one that runs commands as root or with sudo for whoever reaches it. With OwnNetwork,
// Become refuses while another process holds uid (isolate.RefuseStrangers), moves init into a network namespace of
// its own whose loopback alone is up (isolate.OwnNetwork), drops, and then refuses vsock and io_uring to every thread
// (isolate.DenySockets): init and every program it starts reach their own loopback and nothing else, and a failure of
// any step refuses to start.
type Isolation struct {
	OwnNetwork bool
}

// procRoot is the /proc RefuseStrangers reads.
const procRoot = "/proc"

// becomeUser is the uid change Become makes inside dropPrivileges: no supplementary groups, then gid, then uid.
func becomeUser(uid, gid int) func() error {
	return func() error {
		if err := syscall.Setgroups([]int{}); err != nil {
			return fmt.Errorf("cannot drop the supplementary groups: %w", err)
		}
		if err := syscall.Setresgid(gid, gid, gid); err != nil {
			return fmt.Errorf("cannot become gid %d: %w", gid, err)
		}
		if err := syscall.Setresuid(uid, uid, uid); err != nil {
			return fmt.Errorf("cannot become uid %d: %w", uid, err)
		}
		if os.Getuid() != uid || os.Geteuid() != uid || os.Getgid() != gid || os.Getegid() != gid {
			return fmt.Errorf("asked to become %d:%d, init is %d:%d (effective %d:%d)", uid, gid, os.Getuid(), os.Getgid(), os.Geteuid(), os.Getegid())
		}
		return nil
	}
}

// Unprivileged is init's start as the user the provider gave it (Docker: --user). It leaves every thread of init, and so
// every program it starts, with no capability and no way to gain one, whatever the uid, root included: see
// dropPrivileges. It must run before Init.
func Unprivileged() error {
	return dropPrivileges(nil)
}

// dropPrivileges sets no_new_privs and empties the capability bounding set on every thread, calls become (the uid
// change, if any), then empties every thread's effective, permitted, inheritable and ambient sets, and reads all of
// it back. A uid of 0 keeps its capabilities through any uid change, so the sets are emptied for root too; with the
// bounding set empty, not even a program root starts gains one. The bounding set needs CAP_SETPCAP to empty: a process
// that has a capability in it and cannot drop it (EPERM) gets an error, and init refuses to start.
func dropPrivileges(become func() error) error {
	if err := noNewPrivsOnEveryThread(); err != nil {
		return err
	}
	last, err := lastCapability()
	if err != nil {
		return err
	}
	if err := dropBoundingSetOnEveryThread(last); err != nil {
		return err
	}
	if become != nil {
		if err := become(); err != nil {
			return err
		}
	}
	if err := clearCapabilitiesOnEveryThread(); err != nil {
		return err
	}
	return checkUnprivileged(last)
}

// noNewPrivsOnEveryThread sets no_new_privs on every thread of this process: the flag is a thread's, and a program the
// daemon starts inherits it from whichever thread forks it. A binary that links cgo cannot make the call on every
// thread (syscall.ENOTSUP); computerd is built without cgo.
func noNewPrivsOnEveryThread() error {
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); errno != 0 {
		return fmt.Errorf("cannot set no_new_privs on every thread: %w", errno)
	}
	return nil
}

// lastCapability is the highest capability number the running kernel knows, as it publishes it.
func lastCapability() (uintptr, error) {
	text, err := os.ReadFile(capLastCapFile)
	if err != nil {
		return 0, fmt.Errorf("cannot read the kernel's last capability, so cannot empty the bounding set: %w", err)
	}
	last, err := strconv.ParseUint(strings.TrimSpace(string(text)), 10, 8)
	if err != nil || last > 63 {
		return 0, fmt.Errorf("%s reads %q, not a capability number", capLastCapFile, strings.TrimSpace(string(text)))
	}
	return uintptr(last), nil
}

// dropBoundingSetOnEveryThread drops every capability up to last that is still in the bounding set, on every thread,
// so no program the daemon starts can gain one from a file or from being root. It needs CAP_SETPCAP, so it runs before
// any uid change; a capability already gone is not dropped again, so a process started with an empty bounding set
// (Docker: --cap-drop ALL) needs none.
func dropBoundingSetOnEveryThread(last uintptr) error {
	for capability := uintptr(0); capability <= last; capability++ {
		held, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapbsetRead, capability, 0)
		if errno != 0 {
			return fmt.Errorf("cannot read capability %d of the bounding set: %w", capability, errno)
		}
		if held == 0 {
			continue
		}
		if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapbsetDrop, capability, 0); errno != 0 {
			return fmt.Errorf("cannot drop capability %d from the bounding set of every thread: %w; a program init starts could gain it, so init holds CAP_SETPCAP to drop it or starts with it gone (Docker: --cap-drop ALL)", capability, errno)
		}
	}
	return nil
}

type capHeader struct {
	version uint32
	pid     int32
}

type capData struct{ effective, permitted, inheritable uint32 }

// The capset arguments live outside any goroutine's stack, which may move while AllThreadsSyscall runs.
var (
	capsetHeader = capHeader{version: capVersion3}
	capsetData   [2]capData
)

// clearCapabilitiesOnEveryThread empties every thread's ambient, effective, permitted and inheritable sets. Dropping a
// capability needs none. A kernel with no ambient set answers EINVAL to it, and has nothing there to empty.
func clearCapabilitiesOnEveryThread() error {
	if _, _, errno := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClearAll, 0, 0, 0, 0); errno != 0 && errno != syscall.EINVAL {
		return fmt.Errorf("cannot empty the ambient capability set of every thread: %w", errno)
	}
	capsetData = [2]capData{}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&capsetHeader)), uintptr(unsafe.Pointer(&capsetData[0])), 0); errno != 0 {
		return fmt.Errorf("cannot empty the capability sets of every thread: %w", errno)
	}
	return nil
}

// checkUnprivileged reads back what dropPrivileges set: no_new_privs, and no capability up to last in the bounding or
// ambient set, through calls made on every thread, which agree or end the process; and every thread's effective,
// permitted and inheritable sets, by its id.
func checkUnprivileged(last uintptr) error {
	if set, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prGetNoNewPrivs, 0, 0); errno != 0 || set != 1 {
		return fmt.Errorf("no_new_privs reads %d (%v) after it was set", set, errno)
	}
	for capability := uintptr(0); capability <= last; capability++ {
		if held, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapbsetRead, capability, 0); errno != 0 || held != 0 {
			return fmt.Errorf("capability %d reads %d in the bounding set (%v) after it was emptied", capability, held, errno)
		}
		held, _, errno := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientIsSet, capability, 0, 0, 0)
		if (errno != 0 && errno != syscall.EINVAL) || (errno == 0 && held != 0) {
			return fmt.Errorf("capability %d reads %d in the ambient set (%v) after it was emptied", capability, held, errno)
		}
	}
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return fmt.Errorf("cannot list init's threads to read their capabilities back: %w", err)
	}
	for _, task := range tasks {
		tid, err := strconv.Atoi(task.Name())
		if err != nil {
			continue
		}
		header := capHeader{version: capVersion3, pid: int32(tid)}
		var data [2]capData
		if _, _, errno := syscall.RawSyscall(syscall.SYS_CAPGET, uintptr(unsafe.Pointer(&header)), uintptr(unsafe.Pointer(&data[0])), 0); errno != 0 {
			if errno == syscall.ESRCH {
				continue
			}
			return fmt.Errorf("cannot read thread %d's capabilities back: %w", tid, errno)
		}
		if data != [2]capData{} {
			return fmt.Errorf("thread %d still holds capabilities after they were emptied: %+v", tid, data)
		}
	}
	return nil
}

// prepareDir makes dir, with its parents, and makes it uid:gid's alone (0700). A dir that is a symbolic link or not a
// directory is refused, and never followed.
func prepareDir(dir string, uid, gid int) error {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return fmt.Errorf("cannot make %s's parent: %w", dir, err)
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("cannot make %s: %w", dir, err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("cannot read %s: %w", dir, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link; init makes it uid %d's alone only as a directory of its own", dir, uid)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory (mode %v)", dir, info.Mode())
	}
	if err := os.Lchown(dir, uid, gid); err != nil {
		return fmt.Errorf("cannot give %s to %d:%d: %w", dir, uid, gid, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("cannot make %s mode 0700: %w", dir, err)
	}
	return nil
}
