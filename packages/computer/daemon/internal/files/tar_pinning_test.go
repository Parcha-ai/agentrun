package files

import (
	"archive/tar"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

func kindOf(err error) string {
	if err == nil {
		return "ok"
	}
	var e *rpc.Error
	if errors.As(err, &e) {
		return string(e.Kind)
	}
	return "other:" + err.Error()
}

func lsmode(t *testing.T, path string) uint32 {
	t.Helper()
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	return st.Mode & 0o7777
}

// Setuid, setgid and sticky bits in an archive never reach the disk.
func TestSpecialModeBitsNeverReachTheDisk(t *testing.T) {
	root, _ := dirs(t)
	n, err := extractTar(bytes.NewReader(archive(t,
		header{name: "suid", flag: tar.TypeReg, body: "x", mode: 0o4755},
		header{name: "sgid", flag: tar.TypeReg, body: "x", mode: 0o2755},
		header{name: "sticky/", flag: tar.TypeDir, mode: 0o1777},
		header{name: "sdir/", flag: tar.TypeDir, mode: 0o6755},
	)), root)
	if err != nil || n != 4 {
		t.Fatalf("extract: %d %v", n, err)
	}
	for name, want := range map[string]uint32{"suid": 0o755, "sgid": 0o755, "sticky": 0o777, "sdir": 0o755} {
		if got := lsmode(t, filepath.Join(root, name)); got != want {
			t.Errorf("%s: mode %o, want %o", name, got, want)
		}
	}
}

// Device, FIFO, sparse and hard-link entries are refused and leave nothing behind.
func TestDeviceFifoSparseAndHardLinkEntriesAreRefused(t *testing.T) {
	for label, h := range map[string]header{
		"char":        {name: "null", flag: tar.TypeChar},
		"block":       {name: "sda", flag: tar.TypeBlock},
		"fifo":        {name: "pipe", flag: tar.TypeFifo},
		"sparse":      {name: "sp", flag: tar.TypeGNUSparse, body: "x"},
		"hard-inside": {name: "h", flag: tar.TypeLink, link: "ok"},
		"cont":        {name: "c", flag: tar.TypeCont, body: "x"},
	} {
		root, outside := dirs(t)
		var buf bytes.Buffer
		w := tar.NewWriter(&buf)
		_ = w.WriteHeader(&tar.Header{Name: "ok", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1})
		_, _ = w.Write([]byte("k"))
		hdr := &tar.Header{Name: h.name, Linkname: h.link, Typeflag: h.flag, Mode: 0o644, Size: int64(len(h.body)), Devmajor: 1, Devminor: 3}
		if werr := w.WriteHeader(hdr); werr != nil {
			t.Logf("%s: the Go writer refuses this header itself: %v", label, werr)
			continue
		}
		_, _ = w.Write([]byte(h.body))
		_ = w.Close()
		n, err := extractTar(bytes.NewReader(buf.Bytes()), root)
		kind := kindOf(err)
		if kind != "invalid" {
			t.Errorf("%s: want invalid, got %s (wrote %d)", label, kind, n)
		}
		entries, _ := os.ReadDir(root)
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		if strings.Join(names, ",") != "ok" {
			t.Errorf("%s: root holds %v, want only ok", label, names)
		}
		empty(t, outside)
	}
}

// Names that clean to something inside are still refused when they carry "..", a file on the way is
// refused, a long component fails without writing, and "." carries no mode.
func TestPathEdgesAreRefusedOrHarmless(t *testing.T) {
	root, outside := dirs(t)
	if err := os.WriteFile(filepath.Join(root, "f"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("n", 300)
	for label, c := range map[string]struct {
		h    header
		kind string
	}{
		"cleans-inside":  {header{name: "a/../b", flag: tar.TypeReg, body: "x"}, "denied"},
		"dot-dot-only":   {header{name: "..", flag: tar.TypeDir, mode: 0o777}, "denied"},
		"file-on-way":    {header{name: "f/x", flag: tar.TypeReg, body: "x"}, "denied"},
		"long-component": {header{name: long + "/x", flag: tar.TypeReg, body: "x"}, "invalid"},
		"dot-mode-0":     {header{name: "./", flag: tar.TypeDir, mode: 0o1}, "ok"},
		"empty-name":     {header{name: "", flag: tar.TypeReg, body: ""}, "ok"},
	} {
		n, err := extractTar(bytes.NewReader(archive(t, c.h)), root)
		if kind := kindOf(err); kind != c.kind {
			t.Errorf("%s: want %s, got %s (wrote %d)", label, c.kind, kind, n)
		}
	}
	if got := lsmode(t, root); got != 0o755 {
		t.Errorf("root mode became %o", got)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "f")); string(data) != "f" {
		t.Errorf("f was changed: %q", data)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Errorf("root holds %d entries, want 1 (f)", len(entries))
	}
	empty(t, outside)
	// A symlink entry's target is taken as written: pointing outside is allowed, and nothing is written through it.
	n, err := extractTar(bytes.NewReader(archive(t,
		header{name: "l", flag: tar.TypeSymlink, link: outside},
		header{name: "l/x", flag: tar.TypeReg, body: "x"},
	)), root)
	if kind := kindOf(err); kind != "denied" || n != 1 {
		t.Errorf("symlink out then through it: want denied after 1, got %s after %d", kind, n)
	}
	if target, _ := os.Readlink(filepath.Join(root, "l")); target != outside {
		t.Errorf("l -> %q", target)
	}
	empty(t, outside)
}

// A symlink planted in the target before the push, pointing at a directory outside, is never entered,
// and a directory entry at its name is refused rather than chmodding the outside directory.
func TestASymlinkPlantedBeforeThePushIsNeverEntered(t *testing.T) {
	root, outside := dirs(t)
	if err := os.Symlink(outside, filepath.Join(root, "planted")); err != nil {
		t.Fatal(err)
	}
	for label, h := range map[string]header{
		"file-through": {name: "planted/x", flag: tar.TypeReg, body: "x"},
		"dir-through":  {name: "planted/d/", flag: tar.TypeDir, mode: 0o777},
		"dir-at":       {name: "planted/", flag: tar.TypeDir, mode: 0o777},
	} {
		_, err := extractTar(bytes.NewReader(archive(t, h)), root)
		if kind := kindOf(err); kind != "denied" && kind != "exists" {
			t.Errorf("%s: want denied or exists, got %s", label, kind)
		}
	}
	empty(t, outside)
	if got := lsmode(t, outside); got != 0o755 {
		t.Errorf("outside mode became %o", got)
	}
}
