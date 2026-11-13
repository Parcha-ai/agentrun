package files

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// linkMove is the no-replace move where renameat2 is missing: it moves a file, and never replaces one.
func TestLinkMove(t *testing.T) {
	dir := t.TempDir()
	from, to, taken := filepath.Join(dir, "from"), filepath.Join(dir, "to"), filepath.Join(dir, "taken")
	for _, path := range []string{from, taken} {
		if err := os.WriteFile(path, []byte(filepath.Base(path)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := linkMove(from, taken); !errors.Is(err, syscall.EEXIST) {
		t.Fatalf("a move onto a file: %v, want EEXIST", err)
	}
	if data, _ := os.ReadFile(taken); string(data) != "taken" {
		t.Fatalf("the file there was replaced: %q", data)
	}
	if err := linkMove(from, to); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(to); string(data) != "from" {
		t.Fatalf("moved: %q", data)
	}
	if _, err := os.Lstat(from); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the old name is still there: %v", err)
	}
}
