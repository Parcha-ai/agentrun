//go:build linux

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// The real helper on real files, as the image runs it: started by the runner
// (uid and gid 1000, in its own group alone) holding the capabilities the
// image's file capabilities give it. Runs only as root (CI runs it with sudo),
// which it needs to start the runner with those capabilities and to make the
// files an earlier slot left. Everything is made under one temporary folder.

const runnerID = 1000

var helperCaps = []uintptr{capChown, capSetgid, capSetuid, capSetpcap}

type privileged struct {
	t   *testing.T
	bin string
}

// asRunner runs the helper as the runner with the image's capabilities.
func (p privileged) asRunner(args ...string) (int, string, string) {
	p.t.Helper()
	return p.exec(&syscall.SysProcAttr{
		Credential:  &syscall.Credential{Uid: runnerID, Gid: runnerID, Groups: []uint32{runnerID}},
		AmbientCaps: helperCaps,
	}, p.bin, args...)
}

// plainRunner runs a program as the runner with no capability: the server
// reading a run's folder.
func (p privileged) plainRunner(program string, args ...string) (int, string, string) {
	p.t.Helper()
	return p.exec(&syscall.SysProcAttr{Credential: &syscall.Credential{Uid: runnerID, Gid: runnerID, Groups: []uint32{runnerID}}}, program, args...)
}

// inSlot runs a shell line as slot's run, through the helper's run.
func (p privileged) inSlot(slot string, line string) (int, string, string) {
	p.t.Helper()
	return p.asRunner("run", slot, "--", "/bin/sh", "-c", line)
}

func (p privileged) exec(attr *syscall.SysProcAttr, program string, args ...string) (int, string, string) {
	p.t.Helper()
	cmd := exec.Command(program, args...)
	cmd.SysProcAttr = attr
	cmd.Dir = "/"
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), out.String(), errb.String()
	}
	if err != nil {
		p.t.Fatalf("%s %v: %v", program, args, err)
	}
	return 0, out.String(), errb.String()
}

// traversable is a temporary folder every uid may cross (0711), as the
// folders above /data are, its parents up to the system's included.
func traversable(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for at := dir; at != os.TempDir() && at != "/"; at = filepath.Dir(at) {
		must(t, os.Chmod(at, 0o711))
	}
	return dir
}

func owner(t *testing.T, p string) (int, int, uint32) {
	t.Helper()
	var st syscall.Stat_t
	must(t, syscall.Lstat(p, &st))
	return int(st.Uid), int(st.Gid), st.Mode & 0o7777
}

func TestPrivilegedSlotsKeepToTheirOwnFolders(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root, to start the runner with the helper's capabilities (CI: sudo go test -run Privileged)")
	}
	// The helper, where the runner may run it.
	tools := t.TempDir()
	must(t, os.Chmod(tools, 0o755))
	bin := filepath.Join(tools, "agentrun-runas")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	must(t, os.Chmod(bin, 0o755))
	p := privileged{t: t, bin: bin}

	// The data directory, the runner's and traverse-only (0711) as the image's
	// /data, with two runs' folders as the runner lays them.
	data := traversable(t)
	must(t, os.Chown(data, runnerID, runnerID))
	runA, runB := filepath.Join(data, "run-a"), filepath.Join(data, "run-b")
	for _, top := range []string{runA, runB} {
		must(t, os.MkdirAll(filepath.Join(top, "work"), 0o755))
		must(t, os.WriteFile(filepath.Join(top, "work", "input.txt"), []byte("the server's input for "+filepath.Base(top)), 0o600))
		filepath.Walk(top, func(path string, _ os.FileInfo, _ error) error { return os.Lchown(path, runnerID, runnerID) })
	}
	// What an earlier claim's slot (7) left in run A, in its own group (the
	// layout before runs shared the runner's group), and a file of root's.
	left := filepath.Join(runA, "work", "earlier.txt")
	must(t, os.WriteFile(left, []byte("an earlier claim's"), 0o600))
	must(t, os.Chown(left, 1008, 1008))
	rootFile := filepath.Join(runA, "work", "root.txt")
	must(t, os.WriteFile(rootFile, []byte("root's"), 0o600))

	// Run A on slot 3 (uid 1004), run B on slot 4 (uid 1005).
	for _, c := range []struct{ slot, top string }{{"3", runA}, {"4", runB}} {
		if code, _, stderr := p.asRunner("own", c.slot, c.top); code != 0 {
			t.Fatalf("own %s %s: %d %s", c.slot, c.top, code, stderr)
		}
	}
	for _, c := range []struct {
		path     string
		uid, gid int
		mode     uint32
	}{
		{runA, 1004, serverGID, 0o2770},
		{filepath.Join(runA, "work"), 1004, serverGID, 0o2770},
		{filepath.Join(runA, "work", "input.txt"), 1004, serverGID, 0o660},
		{left, 1004, serverGID, 0o660},
		{rootFile, 0, 0, 0o600},
		{runB, 1005, serverGID, 0o2770},
	} {
		uid, gid, mode := owner(t, c.path)
		if uid != c.uid || gid != c.gid || mode != c.mode {
			t.Errorf("%s: %d:%d %#o, want %d:%d %#o", c.path, uid, gid, mode, c.uid, c.gid, c.mode)
		}
	}

	// Each run reads and writes its own folder.
	if code, out, stderr := p.inSlot("3", "cat "+filepath.Join(runA, "work", "input.txt")+" "+left+" && umask && echo mine > "+filepath.Join(runA, "work", "new.txt")); code != 0 || !strings.Contains(out, "the server's input for run-a") || !strings.Contains(out, "an earlier claim's") {
		t.Fatalf("slot 3 in its own folder: %d %q %q", code, out, stderr)
	}
	// Neither reaches the other's: not its folder's list, a file in it, nor a write.
	for _, line := range []string{"ls " + runA, "cat " + filepath.Join(runA, "work", "input.txt"), "cat " + filepath.Join(runA, "work", "new.txt"), "echo theirs > " + filepath.Join(runA, "work", "x.txt")} {
		if code, out, _ := p.inSlot("4", line); code == 0 {
			t.Errorf("slot 4 reached run A's folder: %q answered %q", line, out)
		}
	}
	if code, out, _ := p.inSlot("3", "ls "+runB); code == 0 {
		t.Errorf("slot 3 listed run B's folder: %q", out)
	}
	// A run's process holds its slot's group alone: never the runner's.
	if code, out, stderr := p.inSlot("3", "grep -E '^(Uid|Gid|Groups):' /proc/self/status"); code != 0 || !strings.Contains(out, "Groups:\t1004 \n") || strings.Contains(out, "1000") {
		t.Errorf("slot 3's process: %d %q %q", code, out, stderr)
	}
	// What the run writes is in the runner's group, which reads it through it.
	if uid, gid, mode := owner(t, filepath.Join(runA, "work", "new.txt")); uid != 1004 || gid != serverGID || mode != 0o660 {
		t.Errorf("the run's new file: %d:%d %#o, want 1004:%d 0660", uid, gid, mode, serverGID)
	}
	if code, out, stderr := p.plainRunner("/bin/cat", filepath.Join(runA, "work", "new.txt")); code != 0 || out != "mine\n" {
		t.Errorf("the runner reads the run's file: %d %q %q", code, out, stderr)
	}

	// A folder the run shuts (0700, its setgid bit dropped by its own chmod, as
	// the runner's group is not its own) the runner cannot read while the run
	// holds it ...
	shut := filepath.Join(runA, "work", "shut")
	if code, _, stderr := p.inSlot("3", "mkdir "+shut+" && echo hidden > "+shut+"/f && chmod 600 "+shut+"/f && chmod 700 "+shut); code != 0 {
		t.Fatalf("slot 3 shuts a folder: %d %s", code, stderr)
	}
	if code, out, _ := p.plainRunner("/bin/cat", filepath.Join(shut, "f")); code == 0 {
		t.Errorf("the runner read a folder its run shut, while the run held it: %q", out)
	}
	// ... and is the runner's again once the run ends: its slot reaped and its
	// folder given back.
	if code, _, stderr := p.asRunner("reap", "3"); code != 0 {
		t.Fatalf("reap 3: %d %s", code, stderr)
	}
	if code, _, stderr := p.asRunner("own", "runner", runA); code != 0 {
		t.Fatalf("own runner: %d %s", code, stderr)
	}
	for _, path := range []string{runA, filepath.Join(runA, "work", "new.txt"), shut, filepath.Join(shut, "f")} {
		if uid, gid, _ := owner(t, path); uid != runnerID || gid != serverGID {
			t.Errorf("%s after the give-back: %d:%d, want %d:%d", path, uid, gid, runnerID, serverGID)
		}
	}
	if code, out, stderr := p.plainRunner("/bin/cat", filepath.Join(shut, "f")); code != 0 || out != "hidden\n" {
		t.Errorf("the runner reads the shut folder after the give-back: %d %q %q", code, out, stderr)
	}
	// The slot's next run (another run, the same uid) reaches nothing it left.
	for _, line := range []string{"ls " + runA, "cat " + filepath.Join(runA, "work", "new.txt"), "chmod 777 " + runA} {
		if code, out, _ := p.inSlot("3", line); code == 0 {
			t.Errorf("slot 3's next run reached run A after the give-back: %q answered %q", line, out)
		}
	}
	// Run A's next claim, on slot 4 this time, gets all of it.
	if code, _, stderr := p.asRunner("own", "4", runA); code != 0 {
		t.Fatalf("own 4 run A: %d %s", code, stderr)
	}
	if code, out, stderr := p.inSlot("4", "cat "+filepath.Join(runA, "work", "new.txt")+" "+filepath.Join(shut, "f")+" && echo more >> "+filepath.Join(runA, "work", "new.txt")); code != 0 || out != "mine\nhidden\n" {
		t.Errorf("slot 4 on run A's next claim: %d %q %q", code, out, stderr)
	}
}

// The runner may start the helper's own with its four capabilities, yet own
// keeps CAP_CHOWN alone and never touches what a slot's link points at.
func TestPrivilegedOwnFollowsNoLink(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (CI: sudo go test -run Privileged)")
	}
	tools := t.TempDir()
	must(t, os.Chmod(tools, 0o755))
	bin := filepath.Join(tools, "agentrun-runas")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	must(t, os.Chmod(bin, 0o755))
	p := privileged{t: t, bin: bin}
	data := traversable(t)
	top := filepath.Join(data, "run")
	must(t, os.MkdirAll(top, 0o755))
	// The runner's own secret beside the run's folder, and a link to it a
	// slot left in the folder.
	secret := filepath.Join(data, "seal.key")
	must(t, os.WriteFile(secret, []byte("k"), 0o600))
	must(t, os.Chown(secret, runnerID, runnerID))
	must(t, os.Chown(top, runnerID, runnerID))
	link := filepath.Join(top, "key")
	must(t, os.Symlink(secret, link))
	must(t, os.Lchown(link, 1004, 1004))
	if code, _, stderr := p.asRunner("own", "5", top); code != 0 {
		t.Fatalf("own: %d %s", code, stderr)
	}
	if uid, gid, mode := owner(t, secret); uid != runnerID || gid != runnerID || mode != 0o600 {
		t.Errorf("the link's target changed: %d:%d %#o", uid, gid, mode)
	}
	if uid, gid, _ := owner(t, link); uid != 1006 || gid != serverGID {
		t.Errorf("the link itself: %d:%d, want 1006:%d", uid, gid, serverGID)
	}
}
