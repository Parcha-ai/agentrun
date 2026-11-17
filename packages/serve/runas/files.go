//go:build linux

package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// fixMode copies the owner bits to the group, clears others, setuid and
// sticky, and keeps setgid on directories.
func fixMode(mode uint32, isDir bool) uint32 {
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

// walkOwned calls act for every entry under dir (dir included) owned by
// id, never following symlinks. It descends into others' directories it
// can read; one it cannot read is said and counted as a failure.
func walkOwned(dir string, id int, what string, stderr io.Writer, act func(string, *syscall.Stat_t) error) bool {
	if _, err := lstatOwner(dir); errors.Is(err, fs.ErrNotExist) {
		return true
	}
	ok := true
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			say(stderr, "%s %s: %v", what, p, err)
			ok = false
			return nil
		}
		st, err := lstatOwner(p)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				say(stderr, "%s %s: %v", what, p, err)
				ok = false
			}
			return nil
		}
		if int(st.Uid) != id {
			return nil
		}
		if err := act(p, st); err != nil {
			say(stderr, "%s %s: %v", what, p, err)
			ok = false
		}
		return nil
	})
	return ok
}

// fixDir makes what id left under dir readable and removable by its group.
func fixDir(dir string, id int, stderr io.Writer) bool {
	return walkOwned(dir, id, "fix", stderr, func(p string, st *syscall.Stat_t) error {
		if isLink(st) {
			return nil // chmod would follow it
		}
		return syscall.Chmod(p, fixMode(st.Mode, isDir(st)))
	})
}

// reownDir moves what fromID owns under dir to toID's group.
func reownDir(dir string, fromID, toID int, stderr io.Writer) bool {
	return walkOwned(dir, fromID, "reown", stderr, func(p string, st *syscall.Stat_t) error {
		if err := syscall.Lchown(p, -1, toID); err != nil {
			return err
		}
		if isLink(st) {
			return nil
		}
		return syscall.Chmod(p, fixMode(st.Mode, isDir(st)))
	})
}
