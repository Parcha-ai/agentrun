package process_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
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
//
// The failure is tied to the bytes, not to how the pipe splits them: the first write that reaches past byte 5 writes
// only up to byte 7 and fails there, so the file is "0123456" whether the output came in one read or in three.
func TestALogStopsAtItsFirstFailedWrite(t *testing.T) {
	const failPast, keep = 5, 7
	for _, c := range []struct {
		name string
		// err is what the failing write answers beside the bytes it wrote; nil is a short write.
		err  error
		said *regexp.Regexp
	}{
		{"a full disk", syscall.ENOSPC, regexp.MustCompile(`the log stopped at byte 7: no space left on device`)},
		{"a short write", nil, regexp.MustCompile(`the log stopped at byte 7: it wrote \d+ of \d+ bytes`)},
	} {
		t.Run(c.name, func(t *testing.T) {
			var mu sync.Mutex
			calls, failedAt := 0, 0
			restore := process.SetLogWriteAt(func(f *os.File, p []byte, off int64) (int, error) {
				mu.Lock()
				calls++
				fail := failedAt == 0 && off+int64(len(p)) > failPast
				if fail {
					failedAt = calls
				}
				mu.Unlock()
				if !fail {
					return f.WriteAt(p, off)
				}
				n, _ := f.WriteAt(p[:keep-off], off)
				return n, c.err
			})
			defer restore()
			tbl := table(t, process.Options{})
			path := filepath.Join(t.TempDir(), "output.log")
			// Three writes, apart where the pipe keeps them apart: whichever write fails, nothing after it may land.
			p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "exec 2>&1; printf 01234; sleep 0.3; printf 56789; sleep 0.3; printf abcde"}, Log: path})
			wait(t, tbl, p.ID)
			if got := readAll(t, tbl, p.ID, "log"); got != "0123456" {
				t.Fatalf("the log stream %q", got)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "0123456" {
				t.Fatalf("the file %q %v: not the prefix up to the failure", data, err)
			}
			mu.Lock()
			if failedAt == 0 || calls != failedAt {
				t.Fatalf("%d writes, the failed one #%d: none should follow it", calls, failedAt)
			}
			mu.Unlock()
			res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "log", Offset: off(0)})
			if err != nil || res.Size != keep || !c.said.MatchString(logErrorOf(t, res)) {
				t.Fatalf("the read says %q, size %d (%v); want %s", logErrorOf(t, res), res.Size, err, c.said)
			}
		})
	}
}
