//go:build linux

package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// fixMode copies the owner bits to the group, clears others, setuid and
// sticky, and keeps setgid on directories.
func fixMode(mode uint32, isDir bool) uint32 {
	// A directory is always the owner's to open: one a run left at 0o000 is the
	// server's group's to enter and remove again (0o2770), never kept shut.
	if isDir {
		mode |= 0o700
	}
	m := (mode & 0o700) | ((mode & 0o700) >> 3)
	if isDir {
		m |= 0o2000
	}
	return m
}

func lstatOwner(p string) (*syscall.Stat_t, error) {
	var st syscall.Stat_t
	if err := syscall.Lstat(p, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func isDir(st *syscall.Stat_t) bool  { return st.Mode&syscall.S_IFMT == syscall.S_IFDIR }
func isLink(st *syscall.Stat_t) bool { return st.Mode&syscall.S_IFMT == syscall.S_IFLNK }

// sweepDir removes every top-level entry of dir owned by id, never
// following symlinks. A missing dir is fine.
func sweepDir(dir string, id int, stderr io.Writer) bool {
	ents, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return true
	}
	if err != nil {
		say(stderr, "sweep %s: %v", dir, err)
		return false
	}
	ok := true
	for _, e := range ents {
		p := filepath.Join(dir, e.Name())
		st, err := lstatOwner(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			say(stderr, "sweep %s: %v", p, err)
			ok = false
			continue
		}
		if int(st.Uid) != id {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			// A run may leave its own directories without write or search
			// bits; open them up and try once more.
			openUp(p, id)
			if err := os.RemoveAll(p); err != nil {
				say(stderr, "sweep %s: %v", p, err)
				ok = false
			}
		}
	}
	return ok
}

// openUp gives id's own directories under p owner rwx.
func openUp(p string, id int) {
	_ = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		st, err := lstatOwner(path)
		if err == nil && isDir(st) && int(st.Uid) == id {
			_ = syscall.Chmod(path, 0o700)
		}
		return nil
	})
}

// O_PATH and AT_EMPTY_PATH, which package syscall does not name.
const (
	oPath       = 0x200000
	atEmptyPath = 0x1000
)

// ownDir gives every entry under dir (dir included) that owned() accepts to
// uid, group gid, its mode fixed (fixMode) on the way, and says whether
// every one was. It works on the inodes it checked: each entry is opened
// O_PATH|O_NOFOLLOW at its parent's descriptor, its owner read from that
// descriptor, and its owner and mode changed through it, so a name swapped
// for a symlink or another file between the check and the change changes
// nothing else. An entry owned() refuses (root's, a uid outside the
// runner's and the slots') is left as it is and never descended into. A
// symlink is given (never followed); its mode is not touched.
//
// Each entry passes through the runner's own hands: chowned to runner
// (CAP_CHOWN), its mode set as its owner, then, when uid is not the
// runner's, chowned on to uid. The helper so never needs CAP_FOWNER. A
// directory keeps its setgid bit across a chown; a file has none to keep.
func ownDir(dir string, owned func(int) bool, runner, uid, gid int, stderr io.Writer) bool {
	fd, err := openRetry(dir, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC)
	if errors.Is(err, syscall.ENOENT) {
		return true
	}
	if err != nil {
		say(stderr, "own %s: %v", dir, err)
		return false
	}
	defer syscall.Close(fd)
	return ownAt(fd, dir, owned, runner, uid, gid, stderr)
}

func ownAt(fd int, path string, owned func(int) bool, runner, uid, gid int, stderr io.Writer) bool {
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		say(stderr, "own %s: %v", path, err)
		return false
	}
	if !owned(int(st.Uid)) {
		return true
	}
	fail := func(err error) bool {
		say(stderr, "own %s: %v", path, err)
		return false
	}
	if err := syscall.Fchownat(fd, "", runner, gid, atEmptyPath); err != nil {
		return fail(err)
	}
	ok := true
	if !isLink(&st) {
		// The descriptor's own inode, through /proc: fchmod refuses an O_PATH one.
		if err := syscall.Chmod(fdPath(fd), fixMode(st.Mode, isDir(&st))); err != nil {
			return fail(err)
		}
	}
	if isDir(&st) {
		ok = ownChildren(fd, path, owned, runner, uid, gid, stderr)
	}
	if uid != runner {
		if err := syscall.Fchownat(fd, "", uid, gid, atEmptyPath); err != nil {
			return fail(err)
		}
	}
	return ok
}

func fdPath(fd int) string { return "/proc/self/fd/" + strconv.Itoa(fd) }

// ownChildren gives each entry of the directory fd (an O_PATH one, the
// runner's while this runs) as ownAt gives it.
func ownChildren(fd int, path string, owned func(int) bool, runner, uid, gid int, stderr io.Writer) bool {
	dir, err := openRetry(fdPath(fd), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC)
	if err != nil {
		say(stderr, "own %s: %v", path, err)
		return false
	}
	defer syscall.Close(dir)
	names, err := readNames(dir)
	if err != nil {
		say(stderr, "own %s: %v", path, err)
		return false
	}
	ok := true
	for _, name := range names {
		child, err := syscall.Openat(dir, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if errors.Is(err, syscall.ENOENT) {
			continue
		}
		if err != nil {
			say(stderr, "own %s: %v", filepath.Join(path, name), err)
			ok = false
			continue
		}
		if !ownAt(child, filepath.Join(path, name), owned, runner, uid, gid, stderr) {
			ok = false
		}
		syscall.Close(child)
	}
	return ok
}

// readNames lists a directory descriptor's entries, . and .. left out.
func readNames(dir int) ([]string, error) {
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
			return names, nil
		}
		_, _, names = syscall.ParseDirent(buf[:n], -1, names)
	}
}
