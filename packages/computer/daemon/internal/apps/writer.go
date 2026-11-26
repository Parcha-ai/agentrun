package apps

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

// Writer is a user an app's desktop file must be out of reach of. An app runs its desktop file's Exec, so a user who
// could change that file, or put another in its place, could run any command through apps.launch; the files group
// writes as computerd's own user (Self), with exec off as well.
type Writer struct {
	UID  uint32
	GIDs []uint32
}

// Self is computerd's own user, read when Handlers is called: its uid, its gid and its supplementary groups. That is the
// tool user, the one the files group writes as and programs run as: an init started as root with --user has become that
// user (daemon.Become) before daemon.Init makes the handlers, and with no capability left it runs no program as another.
func Self() Writer {
	w := Writer{UID: uint32(os.Geteuid()), GIDs: []uint32{uint32(os.Getegid())}}
	groups, _ := os.Getgroups()
	for _, gid := range groups {
		w.GIDs = append(w.GIDs, uint32(gid))
	}
	return w
}

// maxLinks is the most symbolic links a walk follows: Linux's own bound on one path (MAXSYMLINKS).
const maxLinks = 40

// Changes says how w could change the desktop file at path, in words, or "" when it could not (Open).
func (w Writer) Changes(path string) string {
	f, err := w.Open(path)
	if err != nil {
		return err.Error()
	}
	f.Close()
	return ""
}

// Open is the desktop file at path, open for reading, when w could not change it, else why in words. The path is walked
// a name at a time from "/" (walk), each symbolic link on the way followed by hand, and the file the walk ends at is the
// one opened: open refuses another put in its place since. ACLs are not read. Root may change anything.
func (w Writer) Open(path string) (*os.File, error) {
	if w.UID == 0 {
		return nil, errors.New("computerd runs as root, which may change any file")
	}
	file, why := w.walk(path)
	if why != "" {
		return nil, errors.New(why)
	}
	return file.open()
}

// walked is the regular file a walk ended at: its path with no symbolic link in it, and what it is (device and inode).
type walked struct {
	path     string
	dev, ino uint64
}

// walk follows path from "/" a name at a time, and says in words how w could change what it names, or "" with the file
// it names when it could not. On the way w must own nothing it passes (a folder, a symbolic link, the file: an owner may
// make any of them writable, or move a link aside), nor may it write a folder holding one, unless the folder is sticky
// (then w may move aside only its own), nor the file. A symbolic link's own mode is not checked by the kernel, so only
// its owner and its folder count; its target is walked from the link's folder (or "/") the same way, up to maxLinks.
func (w Writer) walk(path string) (walked, string) {
	if !filepath.IsAbs(path) {
		return walked{}, fmt.Sprintf("%s is not an absolute path", path)
	}
	var at syscall.Stat_t // the folder the walk is in, dir
	dir := "/"
	if err := syscall.Lstat(dir, &at); err != nil {
		return walked{}, fmt.Sprintf("%s can't be read: %v", dir, err)
	}
	if at.Uid == w.UID {
		return walked{}, fmt.Sprintf("uid %d owns %s", w.UID, dir)
	}
	names, links := strings.Split(path, "/"), 0
	for len(names) > 0 {
		name := names[0]
		names = names[1:]
		switch name {
		case "", ".":
			continue
		case "..":
			// The folder above one the walk went into was passed on the way to it: judged already.
			dir = filepath.Dir(dir)
			if err := syscall.Lstat(dir, &at); err != nil {
				return walked{}, fmt.Sprintf("%s can't be read: %v", dir, err)
			}
			continue
		}
		next := filepath.Join(dir, name)
		var st syscall.Stat_t
		if err := syscall.Lstat(next, &st); err != nil {
			return walked{}, fmt.Sprintf("%s can't be read: %v", next, err)
		}
		if st.Uid == w.UID {
			return walked{}, fmt.Sprintf("uid %d owns %s", w.UID, next)
		}
		if at.Mode&syscall.S_ISVTX == 0 && w.mayWrite(&at) {
			return walked{}, fmt.Sprintf("uid %d may write %s, so it could put another in place of %s", w.UID, dir, next)
		}
		switch st.Mode & syscall.S_IFMT {
		case syscall.S_IFLNK:
			if links++; links > maxLinks {
				return walked{}, fmt.Sprintf("%s: more than %d symbolic links on the way to it", path, maxLinks)
			}
			target, err := os.Readlink(next)
			if err != nil {
				return walked{}, fmt.Sprintf("%s can't be read: %v", next, err)
			}
			if filepath.IsAbs(target) {
				dir = "/"
				if err := syscall.Lstat(dir, &at); err != nil {
					return walked{}, fmt.Sprintf("%s can't be read: %v", dir, err)
				}
			}
			names = append(strings.Split(target, "/"), names...)
		case syscall.S_IFDIR:
			dir, at = next, st
		case syscall.S_IFREG:
			if slices.ContainsFunc(names, func(n string) bool { return n != "" && n != "." }) {
				return walked{}, fmt.Sprintf("%s is a file, not a folder, on the way to %s", next, path)
			}
			if w.mayWrite(&st) {
				return walked{}, fmt.Sprintf("uid %d may write %s", w.UID, next)
			}
			return walked{path: next, dev: uint64(st.Dev), ino: uint64(st.Ino)}, ""
		default:
			return walked{}, fmt.Sprintf("%s is not a regular file", next)
		}
	}
	return walked{}, fmt.Sprintf("%s is a folder, not a desktop file", path)
}

// open is the walked file, opened with no symbolic link followed and refused unless it is the same file the walk
// judged: a regular file of the same device and inode.
func (f walked) open() (*os.File, error) {
	fd, err := syscall.Open(f.path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("%s can't be opened: %v", f.path, err)
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("%s can't be read: %v", f.path, err)
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		syscall.Close(fd)
		return nil, fmt.Errorf("%s is not a regular file", f.path)
	}
	if uint64(st.Dev) != f.dev || uint64(st.Ino) != f.ino {
		syscall.Close(fd)
		return nil, fmt.Errorf("%s was put in place after it was checked: it is not the file that was checked", f.path)
	}
	return os.NewFile(uintptr(fd), f.path), nil
}

// mayWrite is whether st's mode bits let w, which does not own it, write it: its group's bits when w is in its group,
// else everyone's.
func (w Writer) mayWrite(st *syscall.Stat_t) bool {
	if slices.Contains(w.GIDs, st.Gid) {
		return st.Mode&0o020 != 0
	}
	return st.Mode&0o002 != 0
}
