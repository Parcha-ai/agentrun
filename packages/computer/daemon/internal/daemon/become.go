package daemon

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

const prSetNoNewPrivs = 38

// Become is init's start on a vendor that runs every computer as root and has no user of its own to give (Modal: "Modal
// containers always run as root (uid 0)", its USER is ignored). As root it makes HOME and the socket's directory
// uid:gid's alone (0700), sets no_new_privs on every thread, so no setuid program can raise a process again, and then
// becomes uid:gid, which drops every capability. With uid:gid 0:0 it only prepares the directories and sets
// no_new_privs. It must run before Init.
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
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); errno != 0 {
		return fmt.Errorf("cannot set no_new_privs on every thread: %v", errno)
	}
	if uid == 0 && gid == 0 {
		return nil
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
	return nil
}

// noNewPrivsOnEveryThread sets no_new_privs on every thread of this process: not built yet.
func noNewPrivsOnEveryThread() error {
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
