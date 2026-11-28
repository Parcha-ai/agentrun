package apps

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A desktop file is read from the file its walk judged: one put in its place between the walk and the open is refused,
// and the entry is read from the open file, whatever is at its path after.
func TestWriterReadsOnlyTheFileItJudged(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "apps", "a.desktop")
	write(t, path, "[Desktop Entry]\nType=Application\nName=A\nExec=judged\n")
	swap := func(exec string) {
		t.Helper()
		next := filepath.Join(dir, "apps", "next")
		write(t, next, "[Desktop Entry]\nType=Application\nName=A\nExec="+exec+"\n")
		if err := os.Rename(next, path); err != nil {
			t.Fatal(err)
		}
	}

	walked, why := stranger.walk(path)
	if why != "" {
		t.Fatalf("walk(%s): %s, want it out of reach", path, why)
	}
	swap("swapped")
	if f, err := walked.open(); err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "not the file that was checked") {
		if f != nil {
			f.Close()
		}
		t.Fatalf("open after a swap: %v, want it refused, naming %s", err, path)
	}

	f, err := stranger.Open(path)
	if err != nil {
		t.Fatalf("Open(%s): %v", path, err)
	}
	defer f.Close()
	swap("later")
	e, ok := readEntry(f)
	if !ok || e.Exec != "swapped" {
		t.Fatalf("readEntry of the open file = %+v, %v, want the Exec of the file that was open (swapped), not of the one at its path now", e, ok)
	}
}
