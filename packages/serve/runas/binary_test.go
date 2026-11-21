//go:build linux

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestBinaryFailsClosedWithoutCaps builds the real helper and runs it with
// no capabilities: it must stop at setgroups, never exec as the caller.
func TestBinaryFailsClosedWithoutCaps(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs an unprivileged user")
	}
	bin := filepath.Join(t.TempDir(), "agentrun-runas")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	marker := filepath.Join(t.TempDir(), "ran")
	code, stdout, stderr := runBin(t, bin, "run", "0", "--", "/bin/touch", marker)
	if code != 126 {
		t.Fatalf("run: exit %d, stdout %q stderr %q", code, stdout, stderr)
	}
	if !strings.HasPrefix(stderr, "agentrun-runas: setgroups: ") || strings.Count(stderr, "\n") != 1 {
		t.Errorf("run: stderr %q, want one setgroups line", stderr)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("the program ran")
	}

	code, stdout, stderr = runBin(t, bin, "check")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "missing CAP_CHOWN, CAP_SETUID, CAP_SETGID, CAP_SETPCAP") {
		t.Errorf("check: exit %d, stdout %q stderr %q", code, stdout, stderr)
	}

	code, _, stderr = runBin(t, bin, "bogus")
	if code != 2 || !strings.HasPrefix(stderr, "agentrun-runas: usage: ") {
		t.Errorf("usage: exit %d, stderr %q", code, stderr)
	}
}

// TestRealProcReads checks the real readers against this kernel's format.
func TestRealProcReads(t *testing.T) {
	text, err := realSys{}.ReadStatus()
	if err != nil {
		t.Fatal(err)
	}
	st, err := parseStatus(text)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range append([]string{"State", "Uid", "Gid", "Groups", "NoNewPrivs"}, capFields...) {
		if !st.seen[k] {
			t.Errorf("%s not parsed from %q", k, text)
		}
	}
	if st.uid[0] != os.Getuid() || st.gid[0] != os.Getgid() {
		t.Errorf("uid %v gid %v", st.uid, st.gid)
	}
	if !procAlive(text, os.Getuid()) {
		t.Error("this process is not alive")
	}
	last, err := realSys{}.CapLastCap()
	if err != nil || last < 36 || last > 63 {
		t.Errorf("cap_last_cap %d %v", last, err)
	}
	fds, err := realSys{}.ListFds()
	if err != nil {
		t.Fatal(err)
	}
	have := map[int]bool{}
	for _, fd := range fds {
		have[fd] = true
	}
	if !have[0] || !have[1] || !have[2] {
		t.Errorf("fds %v", fds)
	}
}

func runBin(t *testing.T, bin string, args ...string) (int, string, string) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), out.String(), errb.String()
	}
	if err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return 0, out.String(), errb.String()
}
