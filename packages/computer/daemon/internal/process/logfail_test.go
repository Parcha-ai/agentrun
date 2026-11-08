package process_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
)

// logErrorOf is a read's logError as its reply line carries it, "" when it has none.
func logErrorOf(t *testing.T, res process.ReadResult) string {
	t.Helper()
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	said, _ := fields["logError"].(string)
	return said
}

// A log write that fails or writes short stops the log for good: nothing more is written, so the file stays a true
// prefix of the output, and a read of the log stream says why it stopped.
func TestALogStopsAtItsFirstFailedWrite(t *testing.T) {
	for _, c := range []struct {
		name string
		// fail answers the second write, of p: what it wrote of it, and its error.
		fail func(f *os.File, p []byte, off int64) (int, error)
		said string
	}{
		{"a full disk", func(f *os.File, p []byte, off int64) (int, error) {
			n, _ := f.WriteAt(p[:2], off)
			return n, syscall.ENOSPC
		}, "no space left on device"},
		{"a short write", func(f *os.File, p []byte, off int64) (int, error) {
			n, _ := f.WriteAt(p[:2], off)
			return n, nil
		}, "wrote 2 of 5 bytes"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var mu sync.Mutex
			calls := 0
			restore := process.SetLogWriteAt(func(f *os.File, p []byte, off int64) (int, error) {
				mu.Lock()
				calls++
				call := calls
				mu.Unlock()
				if call == 2 {
					return c.fail(f, p, off)
				}
				return f.WriteAt(p, off)
			})
			defer restore()
			tbl := table(t, process.Options{})
			path := filepath.Join(t.TempDir(), "output.log")
			// Three writes, apart: the second fails, and the third, of a disk with room again, must not land after it.
			p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "exec 2>&1; printf 01234; sleep 0.3; printf 56789; sleep 0.3; printf abcde"}, Log: path})
			wait(t, tbl, p.ID)
			if got := readAll(t, tbl, p.ID, "log"); got != "0123456" {
				t.Fatalf("the log stream %q", got)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "0123456" {
				t.Fatalf("the file %q %v: not the prefix up to the failure", data, err)
			}
			mu.Lock()
			if calls != 2 {
				t.Fatalf("%d writes: none should follow the failed one", calls)
			}
			mu.Unlock()
			res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "log", Offset: off(0)})
			if err != nil || res.Size != 7 || !strings.Contains(logErrorOf(t, res), c.said) {
				t.Fatalf("the read says %q, size %d (%v); want %q", logErrorOf(t, res), res.Size, err, c.said)
			}
		})
	}
}
