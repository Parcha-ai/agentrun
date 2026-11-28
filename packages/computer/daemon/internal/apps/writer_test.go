package apps

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// stranger is a user that is not the test's: it owns none of the files the test writes and is in none of their groups.
var stranger = Writer{UID: uint32(os.Getuid()) + 1}

// Changes says how w could change the desktop file at path, in words, or "" when it could not (Open).
func (w Writer) Changes(path string) string {
	f, err := w.Open(path)
	if err != nil {
		return err.Error()
	}
	f.Close()
	return ""
}

// chmod sets path's mode, and sets it back to 0755 when the test ends, so the test's folder can be removed.
func chmod(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o755) })
}

// symlink makes link, and its folder, naming target.
func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// A file the user owns is its own to change, though every folder above it is out of its reach: here one straight in
// the system's sticky temporary folder.
func TestWriterChangesAFileItOwnsInAStickyFolderItDoesNot(t *testing.T) {
	var st syscall.Stat_t
	if err := syscall.Lstat(os.TempDir(), &st); err != nil || st.Mode&syscall.S_ISVTX == 0 {
		t.Skipf("%s is not a sticky folder", os.TempDir())
	}
	for dir := os.TempDir(); ; dir = filepath.Dir(dir) {
		if err := syscall.Lstat(dir, &st); err != nil || st.Uid == uint32(os.Getuid()) || st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
			t.Skipf("%s is not a folder of another user's on a way of folders of others", dir)
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	f, err := os.CreateTemp("", "*.desktop")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	t.Cleanup(func() { _ = os.Remove(f.Name()) })
	self := Writer{UID: uint32(os.Getuid()), GIDs: []uint32{uint32(os.Getgid())}}
	if got, want := self.Changes(f.Name()), fmt.Sprintf("uid %d owns %s", os.Getuid(), f.Name()); got != want {
		t.Fatalf("Changes = %q, want %q", got, want)
	}
}

// The mode bits are not all of what lets a user write: an ACL's entry for it, or a FUSE file system's own rule, shows in
// none of the bits read. So computerd's own user (Self) asks the kernel too, for each folder on the way and for the file,
// and a folder or a file the kernel says it may write is in its reach, whatever the mode bits say. (An ACL entry for the
// test's user on a file it does not own needs another user to set it, so the kernel's answer is given by hand here, and
// asked for the test's own user, whose folders the stranger's bits keep it from.)
func TestWriterAsksTheKernelWhetherItMayWrite(t *testing.T) {
	if Self().kernel == nil {
		t.Fatal("Self asks the kernel nothing: an ACL entry letting computerd's user write a desktop file would go unseen")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "apps", "a.desktop")
	write(t, path, "x")
	if got := stranger.Changes(path); got != "" {
		t.Fatalf("Changes(%s) = %q by mode bits alone, want \"\": the stranger's bits let it write nothing here", path, got)
	}
	for _, named := range []string{filepath.Dir(path), path} {
		w := stranger
		w.kernel = func(p string) bool { return p == named }
		if got := w.Changes(path); !strings.Contains(got, "may write "+named) {
			t.Errorf("Changes(%s), the kernel saying the user may write %s = %q, want it saying so", path, named, got)
		}
	}
	w := stranger
	w.kernel = kernelMayWrite
	if got := w.Changes(path); !strings.Contains(got, "may write") {
		t.Errorf("Changes(%s), asking the kernel for the test's own user = %q, want it saying the user may write a folder on the way", path, got)
	}
	if !kernelMayWrite(path) || (os.Geteuid() != 0 && kernelMayWrite("/")) {
		t.Errorf("kernelMayWrite: %s %v, / %v; want true, and false for a user that is not root", path, kernelMayWrite(path), kernelMayWrite("/"))
	}
}

// A desktop file is out of a user's reach when the user owns neither it nor a folder above it, and the mode bits let
// it write none of them; a sticky folder lets it move aside only its own.
func TestWriterChangesADesktopFileItOwnsOrMayWriteOrMoveAside(t *testing.T) {
	inGroup := Writer{UID: stranger.UID, GIDs: []uint32{uint32(os.Getgid())}}
	self := Writer{UID: uint32(os.Getuid()), GIDs: []uint32{uint32(os.Getgid())}}
	cases := []struct {
		name   string
		writer Writer
		// make lays the file out under dir and gives the path to judge and the path the words name ("" for none).
		make func(t *testing.T, dir string) (path, names string)
		says string
	}{
		{"a file and folders the user neither owns nor may write", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "apps", "a.desktop")
			write(t, path, "x")
			return path, ""
		}, ""},
		// The walk goes down from "/", so the words name the first thing on the way the user owns: the test's own
		// temporary folder, above dir, for the test's own user.
		{"a file the user owns, though it is read-only", self, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "a.desktop")
			write(t, path, "x")
			chmod(t, path, 0o444)
			return path, filepath.Dir(dir)
		}, "owns"},
		{"a read-only folder the user owns, holding a read-only file", self, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "locked", "a.desktop")
			write(t, path, "x")
			chmod(t, path, 0o444)
			chmod(t, filepath.Dir(path), 0o555)
			return path, filepath.Dir(dir)
		}, "owns"},
		{"a file everyone may write", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "a.desktop")
			write(t, path, "x")
			chmod(t, path, 0o646)
			return path, path
		}, "may write"},
		{"a folder the user's group may write", inGroup, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "apps", "a.desktop")
			write(t, path, "x")
			chmod(t, filepath.Dir(path), 0o775)
			return path, filepath.Dir(path)
		}, "may write"},
		{"a folder two above the file that everyone may write", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "share", "applications", "a.desktop")
			write(t, path, "x")
			chmod(t, filepath.Join(dir, "share"), 0o757)
			return path, filepath.Join(dir, "share")
		}, "may write"},
		{"a sticky folder everyone may write, holding a folder that is not the user's", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "tmp", "apps", "a.desktop")
			write(t, path, "x")
			chmod(t, filepath.Join(dir, "tmp"), os.ModeSticky|0o777)
			return path, ""
		}, ""},
		{"a sticky file everyone may write", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "a.desktop")
			write(t, path, "x")
			chmod(t, path, os.ModeSticky|0o646)
			return path, path
		}, "may write"},
		{"a link the user can't change to a file in a folder the user's group may write", inGroup, func(t *testing.T, dir string) (string, string) {
			target := filepath.Join(dir, "writable", "a.desktop")
			write(t, target, "x")
			chmod(t, filepath.Dir(target), 0o775)
			link := filepath.Join(dir, "apps", "a.desktop")
			write(t, filepath.Join(dir, "apps", "other"), "x")
			chmod(t, filepath.Dir(link), 0o755)
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			return link, filepath.Dir(target)
		}, "may write"},
		{"a link to a file out of reach", stranger, func(t *testing.T, dir string) (string, string) {
			target := filepath.Join(dir, "system", "a.desktop")
			write(t, target, "x")
			link := filepath.Join(dir, "apps", "a.desktop")
			write(t, filepath.Join(dir, "apps", "other"), "x")
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			return link, ""
		}, ""},
		{"a link out of reach to a link in a folder everyone may write, on to a file out of reach", stranger, func(t *testing.T, dir string) (string, string) {
			target := filepath.Join(dir, "system", "real", "a.desktop")
			write(t, target, "x")
			hop := filepath.Join(dir, "home", "hop")
			symlink(t, target, hop)
			chmod(t, filepath.Dir(hop), 0o757)
			link := filepath.Join(dir, "system", "applications", "a.desktop")
			symlink(t, hop, link)
			return link, hop
		}, "may write"},
		{"a link out of reach naming, by a relative path, a link in a folder everyone may write", stranger, func(t *testing.T, dir string) (string, string) {
			target := filepath.Join(dir, "system", "real", "a.desktop")
			write(t, target, "x")
			hop := filepath.Join(dir, "home", "hop")
			symlink(t, target, hop)
			chmod(t, filepath.Dir(hop), 0o757)
			link := filepath.Join(dir, "system", "applications", "a.desktop")
			symlink(t, filepath.Join("..", "..", "home", "hop"), link)
			return link, hop
		}, "may write"},
		{"a link to a link to a file, all out of reach", stranger, func(t *testing.T, dir string) (string, string) {
			target := filepath.Join(dir, "system", "real", "a.desktop")
			write(t, target, "x")
			hop := filepath.Join(dir, "system", "alternatives", "a.desktop")
			symlink(t, filepath.Join("..", "real", "a.desktop"), hop)
			link := filepath.Join(dir, "system", "applications", "a.desktop")
			symlink(t, hop, link)
			return link, ""
		}, ""},
		{"a link that names itself", stranger, func(t *testing.T, dir string) (string, string) {
			link := filepath.Join(dir, "apps", "a.desktop")
			symlink(t, link, link)
			return link, ""
		}, "more than 40 symbolic links"},
		{"a named pipe, which is no desktop file", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "a.desktop")
			if err := syscall.Mkfifo(path, 0o644); err != nil {
				t.Fatal(err)
			}
			return path, path
		}, "not a regular file"},
		{"a file that is not there", stranger, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "gone.desktop")
			return path, path
		}, "can't be read"},
		{"any file, when the user is root", Writer{UID: 0}, func(t *testing.T, dir string) (string, string) {
			path := filepath.Join(dir, "a.desktop")
			write(t, path, "x")
			return path, ""
		}, "computerd runs as root"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, names := c.make(t, t.TempDir())
			got := c.writer.Changes(path)
			if c.says == "" {
				if got != "" {
					t.Fatalf("Changes(%s) = %q, want \"\": the user can't change it", path, got)
				}
				return
			}
			named := strings.HasSuffix(got, " "+names) || strings.HasPrefix(got, names+" ") || strings.Contains(got, " "+names+",")
			if !strings.Contains(got, c.says) || (names != "" && !named) {
				t.Fatalf("Changes(%s) = %q, want it saying %q of %s", path, got, c.says, names)
			}
		})
	}
}
