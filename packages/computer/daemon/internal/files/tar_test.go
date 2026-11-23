package files

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

type header struct {
	name, link string
	flag       byte
	body       string
	mode       int64
	mtime      time.Time
}

func archive(t *testing.T, headers ...header) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, h := range headers {
		mode := h.mode
		if mode == 0 {
			mode = 0o644
		}
		if err := w.WriteHeader(&tar.Header{Name: h.name, Linkname: h.link, Typeflag: h.flag, Mode: mode, Size: int64(len(h.body)), ModTime: h.mtime}); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, h.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// dirs makes a target directory and a directory outside it, each empty.
func dirs(t *testing.T) (root, outside string) {
	t.Helper()
	base := t.TempDir()
	root, outside = filepath.Join(base, "root"), filepath.Join(base, "outside")
	for _, dir := range []string{root, outside} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return root, outside
}

func wantKind(t *testing.T, err error, kind rpc.Kind, entry string) {
	t.Helper()
	var e *rpc.Error
	if !errors.As(err, &e) || e.Kind != kind || !strings.Contains(e.Message, entry) {
		t.Fatalf("want %s naming %q, got %v", kind, entry, err)
	}
}

func empty(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("%s holds %v: something was written outside the target", dir, names)
	}
}

// A directory an entry needs, made and checked, then replaced by a symlink to an outside directory before it is used:
// the entry is refused, and nothing is written through the symlink.
func TestADirectorySwappedForASymlinkBetweenCheckAndUseIsRefused(t *testing.T) {
	root, outside := dirs(t)
	var swapped []string
	betweenCheckAndUse = func(rel string) {
		swapped = append(swapped, rel)
		_ = os.Remove(filepath.Join(root, rel))
		if err := os.Symlink(outside, filepath.Join(root, rel)); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { betweenCheckAndUse = nil })
	_, err := extractTar(bytes.NewReader(archive(t, header{name: "a/file", flag: tar.TypeReg, body: "x"})), root)
	empty(t, outside)
	if strings.Join(swapped, " ") != "a" {
		t.Fatalf("the hook ran for %v, want [a]", swapped)
	}
	wantKind(t, err, rpc.KindDenied, "a/file")
}

// A symlink on the way to an entry is never followed, whether it leads out of the target or stays in it.
func TestASymlinkOnTheWayIsNeverFollowed(t *testing.T) {
	root, outside := dirs(t)
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for link, target := range map[string]string{"out": outside, "in": "sub"} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"out/f", "in/f", "in/deeper/f", "out/"} {
		entry := header{name: name, flag: tar.TypeReg, body: "x"}
		if strings.HasSuffix(name, "/") {
			name = name + "d/"
			entry = header{name: name, flag: tar.TypeDir, mode: 0o755}
		}
		_, err := extractTar(bytes.NewReader(archive(t, entry)), root)
		wantKind(t, err, rpc.KindDenied, name)
	}
	empty(t, outside)
	empty(t, filepath.Join(root, "sub"))
}

// A file or symlink entry at a symlink replaces the link itself, never what it points to; a directory entry there is
// refused.
func TestALeafSymlinkIsReplacedNeverFollowed(t *testing.T) {
	root, outside := dirs(t)
	target := filepath.Join(outside, "target")
	if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	for link, to := range map[string]string{"f": target, "l": target, "d": outside} {
		if err := os.Symlink(to, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	n, err := extractTar(bytes.NewReader(archive(t,
		header{name: "f", flag: tar.TypeReg, body: "new", mode: 0o600},
		header{name: "l", flag: tar.TypeSymlink, link: "elsewhere"},
	)), root)
	if err != nil || n != 2 {
		t.Fatalf("extract: %d %v", n, err)
	}
	if info, err := os.Lstat(filepath.Join(root, "f")); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("f is %v %v, want a 0600 file", info, err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "f")); string(data) != "new" {
		t.Fatalf("f holds %q", data)
	}
	if link, err := os.Readlink(filepath.Join(root, "l")); err != nil || link != "elsewhere" {
		t.Fatalf("l is %q %v", link, err)
	}
	if data, _ := os.ReadFile(target); string(data) != "keep" {
		t.Fatalf("the link's target was written: %q", data)
	}
	_, err = extractTar(bytes.NewReader(archive(t, header{name: "d/", flag: tar.TypeDir, mode: 0o700})), root)
	wantKind(t, err, rpc.KindExists, "d/")
	if info, _ := os.Stat(outside); info.Mode().Perm() != 0o755 {
		t.Fatalf("the outside directory's mode became %o", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 1 || entries[0].Name() != "target" {
		t.Fatalf("outside holds %v", entries)
	}
}

// A directory the archive made, replaced by a symlink to an outside directory before the archive ends, never gets
// its mode applied through the link.
func TestADirectoryModeIsNeverAppliedThroughASymlink(t *testing.T) {
	root, outside := dirs(t)
	whole := archive(t, header{name: "d/", flag: tar.TypeDir, mode: 0o750}, header{name: "later", flag: tar.TypeReg, body: "x"})
	r, w := io.Pipe()
	result := make(chan error, 1)
	go func() {
		_, err := extractTar(r, root)
		_ = r.CloseWithError(err)
		result <- err
	}()
	if _, err := w.Write(whole[:512]); err != nil {
		t.Fatal(err)
	}
	made := filepath.Join(root, "d")
	for deadline := time.Now().Add(10 * time.Second); ; {
		if info, err := os.Lstat(made); err == nil && info.IsDir() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("d was never made")
		}
		time.Sleep(time.Millisecond)
	}
	if err := os.Remove(made); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, made); err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write(whole[512:])
	_ = w.Close()
	err := <-result
	if info, _ := os.Stat(outside); info.Mode().Perm() != 0o755 {
		t.Fatalf("the outside directory's mode became %o through the symlink", info.Mode().Perm())
	}
	wantKind(t, err, rpc.KindDenied, "d")
}

// A file gets its header's mtime, as tar gives it, a new one and one written over a file already there alike: so a
// synced folder's push (sync-folder.ts PUSHED_MTIME) leaves every file at a time no later write gives it.
func TestAFileGetsItsHeadersMtime(t *testing.T) {
	root, _ := dirs(t)
	if err := os.WriteFile(filepath.Join(root, "there"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	pushed := time.Unix(946_684_800, 0)
	n, err := extractTar(bytes.NewReader(archive(t,
		header{name: "new", flag: tar.TypeReg, body: "n", mtime: pushed},
		header{name: "there", flag: tar.TypeReg, body: "new", mtime: pushed},
		header{name: "d/", flag: tar.TypeDir, mode: 0o755},
		header{name: "d/later", flag: tar.TypeReg, body: "l", mtime: pushed.Add(time.Hour)},
	)), root)
	if err != nil || n != 4 {
		t.Fatalf("extract: %d %v", n, err)
	}
	for name, want := range map[string]time.Time{"new": pushed, "there": pushed, "d/later": pushed.Add(time.Hour)} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if !info.ModTime().Equal(want) {
			t.Fatalf("%s has mtime %v, want its header's %v", name, info.ModTime().UTC(), want.UTC())
		}
	}
	if data, _ := os.ReadFile(filepath.Join(root, "there")); string(data) != "new" {
		t.Fatalf("there holds %q", data)
	}
}

// Under umask 077 (init's on the exec path), a directory only an entry's path names is made 0755, and one the archive
// names gets its header's mode: neither takes the umask, so a synced folder records no mode no one gave.
func TestADirectoryMadeForAnEntryIs0755WhateverTheUmask(t *testing.T) {
	root, _ := dirs(t)
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	n, err := extractTar(bytes.NewReader(archive(t,
		header{name: "named/", flag: tar.TypeDir, mode: 0o750},
		header{name: "named/a", flag: tar.TypeReg, body: "a"},
		header{name: "unnamed/deep/b", flag: tar.TypeReg, body: "b"},
	)), root)
	if err != nil || n != 3 {
		t.Fatalf("extract: %d %v", n, err)
	}
	for name, want := range map[string]os.FileMode{"named": 0o750, "unnamed": 0o755, "unnamed/deep": 0o755, "named/a": 0o644, "unnamed/deep/b": 0o644} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s is %o, want %o", name, info.Mode().Perm(), want)
		}
	}
}
