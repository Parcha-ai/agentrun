package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func etcWith(t *testing.T, passwd, group string) string {
	t.Helper()
	etc := t.TempDir()
	for name, text := range map[string]string{"passwd": passwd, "group": group} {
		if err := os.WriteFile(filepath.Join(etc, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return etc
}

func read(t *testing.T, etc, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(etc, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestNameUserAddsTheToolUserWhereTheUidHasNoName(t *testing.T) {
	// E2B Desktop's: root and its own user, no 2510; the group file ends with no newline.
	etc := etcWith(t, "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/bash\n", "root:x:0:\nuser:x:1000:")
	if err := NameUser(etc, 2510, 2510, "/work"); err != nil {
		t.Fatal(err)
	}
	if got, want := read(t, etc, "passwd"), "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/bash\nagentrun-tool:x:2510:2510:agentrun tool user:/work:/bin/sh\n"; got != want {
		t.Fatalf("passwd reads %q, want %q", got, want)
	}
	if got, want := read(t, etc, "group"), "root:x:0:\nuser:x:1000:\nagentrun-tool:x:2510:\n"; got != want {
		t.Fatalf("group reads %q, want %q", got, want)
	}
	// Once named, a second init (one that starts itself again in a user namespace) changes nothing.
	if err := NameUser(etc, 2510, 2510, "/work"); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(read(t, etc, "passwd"), ":2510:"); n != 1 {
		t.Fatalf("after a second NameUser, passwd has %d entries for 2510", n)
	}
}

func TestNameUserLeavesANamedUidAndTakesAnotherNameWhenOursIsTaken(t *testing.T) {
	// The box image's: agentrun-tool is 2510 already.
	etc := etcWith(t, "root:x:0:0::/root:/bin/sh\nagentrun-tool:x:2510:2510::/tmp:/bin/sh\n", "root:x:0:\nagentrun-tool:x:2510:\n")
	before := read(t, etc, "passwd")
	if err := NameUser(etc, 2510, 2510, "/work"); err != nil {
		t.Fatal(err)
	}
	if read(t, etc, "passwd") != before {
		t.Fatal("NameUser changed the passwd of a uid that has a name")
	}
	// Another uid, where agentrun-tool is taken: agentrun-<uid>.
	if err := NameUser(etc, 3000, 2510, "/work"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(read(t, etc, "passwd"), "agentrun-3000:x:3000:2510:agentrun tool user:/work:/bin/sh\n") {
		t.Fatalf("passwd reads %q", read(t, etc, "passwd"))
	}
	if strings.Contains(read(t, etc, "group"), "agentrun-3000") {
		t.Fatal("NameUser added a group for gid 2510, which has one")
	}
}

func TestNameUserSaysWhyItCannot(t *testing.T) {
	if err := NameUser(t.TempDir(), 2510, 2510, "/work"); err == nil || !strings.Contains(err.Error(), "passwd") {
		t.Fatalf("NameUser with no passwd file: %v; want an error that names it", err)
	}
	etc := etcWith(t, "agentrun-tool:x:1:1::/:/bin/sh\nagentrun-2510:x:2:2::/:/bin/sh\n", "")
	if err := NameUser(etc, 2510, 2510, "/work"); err == nil || !strings.Contains(err.Error(), "gets no name") {
		t.Fatalf("NameUser with both names taken: %v; want a refusal in words", err)
	}
}
