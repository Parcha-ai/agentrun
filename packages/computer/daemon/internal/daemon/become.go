package daemon

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	prCapbsetRead   = 23
	prCapbsetDrop   = 24
	prSetNoNewPrivs = 38
	capVersion3     = 0x20080522
)

// Become is init's start on a vendor that runs every computer as root and has no user of its own to give (Modal: "Modal
// containers always run as root (uid 0)", its USER is ignored), or whose image's privilege tools cannot be relied on
// (Daytona: the default snapshot's setpriv is BusyBox's). As root it makes HOME and the socket's directory uid:gid's
// alone (0700), sets no_new_privs on every thread, so no setuid program can raise a process again, empties the
// capability bounding set on every thread, and then becomes uid:gid with no supplementary groups, which drops every
// permitted and effective capability; the inheritable set is emptied after. With uid:gid 0:0 it only prepares the
// directories and sets no_new_privs. It must run before Init.
func Become(uid, gid int, home, socket string) error {
	if !filepath.IsAbs(home) {
		return fmt.Errorf("--user needs HOME to be an absolute path, the computer's user's own; it is %q", home)
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("--user needs init to start as root, to give HOME and %s to uid %d and then become it; it runs as uid %d, so the provider gives the user itself (Docker: --user)", filepath.Dir(socket), uid, os.Geteuid())
	}
	for _, dir := range []string{home, filepath.Dir(socket)} {
		if err := prepareDir(dir, uid, gid); err != nil {
			return err
		}
	}
	if err := noNewPrivsOnEveryThread(); err != nil {
		return err
	}
	if uid == 0 && gid == 0 {
		return nil
	}
	if err := dropBoundingSetOnEveryThread(); err != nil {
		return err
	}
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
	return clearCapabilitiesOnEveryThread()
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

// dropBoundingSetOnEveryThread drops every capability the kernel knows (PR_CAPBSET_READ answers EINVAL past the last)
// from the bounding set of every thread, so no program the daemon starts can gain one from a file. It needs
// CAP_SETPCAP, so it runs before the uid is dropped.
func dropBoundingSetOnEveryThread() error {
	for capability := uintptr(0); ; capability++ {
		if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prCapbsetRead, capability, 0); errno == syscall.EINVAL {
			return nil
		}
		if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapbsetDrop, capability, 0); errno != 0 {
			return fmt.Errorf("cannot drop capability %d from the bounding set of every thread: %w", capability, errno)
		}
	}
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

// clearCapabilitiesOnEveryThread empties every thread's effective, permitted and inheritable sets. After the uid drop
// the first two are already empty; the inheritable set is not, and an empty permitted set keeps the ambient one empty.
func clearCapabilitiesOnEveryThread() error {
	capsetData = [2]capData{}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&capsetHeader)), uintptr(unsafe.Pointer(&capsetData[0])), 0); errno != 0 {
		return fmt.Errorf("cannot empty the capability sets of every thread: %w", errno)
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
