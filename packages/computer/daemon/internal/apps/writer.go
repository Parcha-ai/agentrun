package apps

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
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

// Changes says how w could change the desktop file at path, in words, or "" when it could not: w owns the file or a
// folder above it (an owner may make either writable), or its mode bits let w write one, unless that one is a folder
// with the sticky bit and what is in it is not w's (w can't move that aside). After a symbolic link, the file it names
// is held to the same. A file that can't be read counts as one w could change. Root may change anything. ACLs are not
// read.
func (w Writer) Changes(path string) string {
	if w.UID == 0 {
		return "computerd runs as root, which may change any file"
	}
	if why := w.changesOnTheWay(path); why != "" {
		return why
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Sprintf("%s can't be followed: %v", path, err)
	}
	if real != filepath.Clean(path) {
		return w.changesOnTheWay(real)
	}
	return ""
}

// changesOnTheWay is Changes for path itself and each folder above it, a symbolic link taken as itself.
func (w Writer) changesOnTheWay(path string) string {
	for p, above := filepath.Clean(path), false; ; p, above = filepath.Dir(p), true {
		var st syscall.Stat_t
		if err := syscall.Lstat(p, &st); err != nil {
			return fmt.Sprintf("%s can't be read: %v", p, err)
		}
		if st.Uid == w.UID {
			return fmt.Sprintf("uid %d owns %s", w.UID, p)
		}
		// A symbolic link's own mode is not checked by the kernel: only its folder decides who may replace it. In a
		// sticky folder w may move aside only its own, and what is in it on the way here is not w's (checked above).
		link := st.Mode&syscall.S_IFMT == syscall.S_IFLNK
		sticky := above && st.Mode&syscall.S_ISVTX != 0
		if !link && !sticky && w.mayWrite(&st) {
			return fmt.Sprintf("uid %d may write %s", w.UID, p)
		}
		if filepath.Dir(p) == p {
			return ""
		}
	}
}

// mayWrite is whether st's mode bits let w, which does not own it, write it: its group's bits when w is in its group,
// else everyone's.
func (w Writer) mayWrite(st *syscall.Stat_t) bool {
	if slices.Contains(w.GIDs, st.Gid) {
		return st.Mode&0o020 != 0
	}
	return st.Mode&0o002 != 0
}
