package files_test

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/files"
)

func tarOf(t *testing.T, hdr *tar.Header, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	hdr.Size = int64(len(body))
	if err := w.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// Two pushes into one directory at once, one making a a symlink to an outside directory and the other writing a/file:
// whichever wins, nothing lands outside.
func TestConcurrentPushesNeverWriteOutsideTheTarget(t *testing.T) {
	for round := range 200 {
		base := t.TempDir()
		dst, outside := filepath.Join(base, "dst"), filepath.Join(base, "outside")
		for _, dir := range []string{dst, outside} {
			if err := os.Mkdir(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		archives := [][]byte{
			tarOf(t, &tar.Header{Name: "a/", Linkname: outside, Typeflag: tar.TypeSymlink, Mode: 0o777}, ""),
			tarOf(t, &tar.Header{Name: "a/file", Typeflag: tar.TypeReg, Mode: 0o644}, "x"),
		}
		pushes := files.NewPushes()
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, archive := range archives {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				begun, err := pushes.Begin(files.PushBeginParams{Path: dst})
				if err != nil {
					t.Error(err)
					return
				}
				if _, err := pushes.Write(files.PushWriteParams{ID: begun.ID, Data: archive}); err != nil {
					return
				}
				_, _ = pushes.End(files.PushEndParams{ID: begun.ID})
			}()
		}
		close(start)
		wg.Wait()
		_ = pushes.Close()
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Fatalf("round %d: %s holds %d entries: a push wrote outside its target", round, outside, len(entries))
		}
	}
}
