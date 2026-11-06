package files

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// returnsWithin runs fn and fails the test if fn has not returned within a minute: a call that blocks opening a FIFO
// fails here instead of hanging the suite.
func returnsWithin(t *testing.T, what string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(time.Minute):
		t.Fatalf("%s did not return within a minute: it blocked", what)
	}
}

// mkfifo and writeFile report with t.Error, not t.Fatal: a swap runs them on the goroutine that opens the file.
func mkfifo(t *testing.T, path string) {
	t.Helper()
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Error(err)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Error(err)
	}
}

// swapOnce sets beforeOpen to remove path and run swap the first time path is opened, and clears it when the test
// ends.
func swapOnce(t *testing.T, path string, swap func(t *testing.T, path string)) {
	t.Helper()
	swapped := false
	beforeOpen = func(p string) {
		if p == path && !swapped {
			swapped = true
			if err := os.Remove(p); err != nil {
				t.Error(err)
			}
			swap(t, p)
		}
	}
	t.Cleanup(func() { beforeOpen = nil })
}

// pullAll pulls path to its end and returns each entry's name and body.
func pullAll(t *testing.T, path string) map[string]string {
	t.Helper()
	pulls := NewPulls()
	var archive bytes.Buffer
	var pullErr error
	returnsWithin(t, "the pull", func() {
		begun, err := pulls.Begin(PullBeginParams{Path: path})
		if err != nil {
			pullErr = err
			return
		}
		for {
			read, err := pulls.Read(PullReadParams{ID: begun.ID})
			if err != nil {
				pullErr = err
				break
			}
			archive.Write(read.Data)
			if read.EOF {
				break
			}
		}
		_, _ = pulls.End(PullEndParams{ID: begun.ID})
	})
	if pullErr != nil {
		t.Fatalf("pull: %v", pullErr)
	}
	entries := map[string]string{}
	r := tar.NewReader(&archive)
	for {
		hdr, err := r.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(r)
		if err != nil {
			t.Fatal(err)
		}
		entries[hdr.Name] = string(body)
	}
	return entries
}

// A file the pull's walk saw as regular, then replaced before the pull opens it: the pull ends, never waiting on a
// FIFO, and its entry's header matches what was read.
func TestAPullOfAFileReplacedAfterTheWalkEnds(t *testing.T) {
	for _, c := range []struct {
		name string
		swap func(t *testing.T, path string)
		want map[string]string
	}{
		{"a FIFO", mkfifo, map[string]string{"a.txt": "a"}},
		{"a symlink to a FIFO", func(t *testing.T, path string) {
			fifo := path + ".fifo"
			mkfifo(t, fifo)
			if err := os.Symlink(fifo, path); err != nil {
				t.Error(err)
			}
		}, map[string]string{"a.txt": "a"}},
		{"a longer file", func(t *testing.T, path string) { writeFile(t, path, "longer") }, map[string]string{"a.txt": "a", "b.txt": "longer"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			writeFile(t, filepath.Join(dir, "a.txt"), "a")
			writeFile(t, filepath.Join(dir, "b.txt"), "b")
			swapOnce(t, filepath.Join(dir, "b.txt"), c.swap)
			if got := pullAll(t, dir); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("pulled %v, want %v", got, c.want)
			}
		})
	}
}

// A FIFO in the pulled tree from the start is left out, as before.
func TestAPullLeavesOutAFIFOInTheTree(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.txt"), "a")
	mkfifo(t, filepath.Join(dir, "pipe"))
	if got, want := pullAll(t, dir), map[string]string{"a.txt": "a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pulled %v, want %v", got, want)
	}
}

func readAndWrite(t *testing.T, path string) {
	t.Helper()
	var readErr, writeErr error
	returnsWithin(t, "files.read", func() { _, readErr = Read(ReadParams{Path: path}) })
	wantKind(t, readErr, rpc.KindInvalid, path)
	returnsWithin(t, "files.write", func() { _, writeErr = Write(WriteParams{Path: path, Data: []byte("x")}) })
	wantKind(t, writeErr, rpc.KindInvalid, path)
}

// files.read and files.write of a FIFO refuse it at once.
func TestReadAndWriteRefuseAFIFO(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pipe")
	mkfifo(t, path)
	readAndWrite(t, path)
}

// files.read and files.write of a file replaced by a FIFO just before they open it refuse it at once, never waiting
// for the FIFO's other end.
func TestReadAndWriteOfAFileReplacedByAFIFOReturn(t *testing.T) {
	for _, call := range []string{"read", "write"} {
		t.Run(call, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "f")
			writeFile(t, path, "f")
			swapOnce(t, path, mkfifo)
			var err error
			returnsWithin(t, "files."+call, func() {
				if call == "read" {
					_, err = Read(ReadParams{Path: path})
				} else {
					_, err = Write(WriteParams{Path: path, Data: []byte("x")})
				}
			})
			wantKind(t, err, rpc.KindInvalid, path)
		})
	}
}
