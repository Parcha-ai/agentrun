package daemon

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

func ownerAndMode(t *testing.T, path string) (int, int, os.FileMode) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	st := info.Sys().(*syscall.Stat_t)
	return int(st.Uid), int(st.Gid), info.Mode()
}

func TestPrepareDirMakesAMissingDirectoryTheUsersAlone(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "work", "home")
	if err := prepareDir(dir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	uid, gid, mode := ownerAndMode(t, dir)
	if !mode.IsDir() || mode.Perm() != 0o700 || uid != os.Getuid() || gid != os.Getgid() {
		t.Fatalf("%s: mode %v owned by %d:%d; want a directory, 0700, owned by %d:%d", dir, mode, uid, gid, os.Getuid(), os.Getgid())
	}
}

func TestPrepareDirTightensAnExistingDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "work")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := prepareDir(dir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if _, _, mode := ownerAndMode(t, dir); mode.Perm() != 0o700 {
		t.Fatalf("mode %v after prepareDir, want 0700", mode.Perm())
	}
}

func TestPrepareDirRefusesASymbolicLinkAndLeavesItsTarget(t *testing.T) {
	target := t.TempDir()
	if err := os.Chmod(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "work")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	err := prepareDir(link, os.Getuid(), os.Getgid())
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("prepareDir of a symbolic link: %v; want a refusal that names the symbolic link", err)
	}
	if _, _, mode := ownerAndMode(t, target); mode.Perm() != 0o755 {
		t.Fatalf("the link's target is now %v; prepareDir must not follow the link", mode.Perm())
	}
}

func TestPrepareDirRefusesAFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "work")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareDir(file, os.Getuid(), os.Getgid()); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("prepareDir of a file: %v; want a refusal in words", err)
	}
}

func TestBecomeRefusesARelativeHome(t *testing.T) {
	for _, home := range []string{"", "work", "./work"} {
		err := Become(1000, 1000, home, filepath.Join(t.TempDir(), "computerd.sock"))
		if err == nil || !strings.Contains(err.Error(), "HOME") {
			t.Errorf("Become with HOME %q: %v; want a refusal that names HOME", home, err)
		}
	}
}

func TestBecomeNeedsInitToStartAsRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("runs as root: the drop itself is a live case, never run in a test process")
	}
	home := filepath.Join(t.TempDir(), "work")
	err := Become(1000, 1000, home, filepath.Join(t.TempDir(), "run", "computerd.sock"))
	if err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("Become as uid %d: %v; want a refusal that says init must start as root", os.Geteuid(), err)
	}
	if _, statErr := os.Stat(home); statErr == nil {
		t.Fatalf("Become made %s before it refused", home)
	}
}

// NoNewPrivsChildArg runs this test binary as noNewPrivsChild (see TestMain).
const NoNewPrivsChildArg = "no-new-privs-on-every-thread"

// noNewPrivsChild holds threads of its own, sets no_new_privs on every thread, and prints each thread's NoNewPrivs
// from /proc/self/task, one "tid value" line each; or "unsupported" in a binary that links cgo, where Go cannot make
// one call on every thread. It runs as a process of its own, since no_new_privs is never cleared.
func noNewPrivsChild() int {
	const held = 4
	ready := make(chan struct{})
	for range held {
		go func() {
			runtime.LockOSThread()
			ready <- struct{}{}
			select {}
		}()
	}
	for range held {
		<-ready
	}
	if err := noNewPrivsOnEveryThread(); err != nil {
		if errors.Is(err, syscall.ENOTSUP) {
			fmt.Println("unsupported")
			return 0
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	for _, task := range tasks {
		status, err := os.ReadFile(filepath.Join("/proc/self/task", task.Name(), "status"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		value := "missing"
		for line := range strings.Lines(string(status)) {
			if rest, ok := strings.CutPrefix(line, "NoNewPrivs:"); ok {
				value = strings.TrimSpace(rest)
			}
		}
		fmt.Println(task.Name(), value)
	}
	return 0
}

func TestNoNewPrivsHoldsOnEveryThread(t *testing.T) {
	cmd := exec.Command(os.Args[0], NoNewPrivsChildArg)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("the child: %v; stderr: %s", err, stderr.String())
	}
	if strings.TrimSpace(string(out)) == "unsupported" {
		t.Skip("this test binary links cgo, where Go cannot make one call on every thread; computerd is built with CGO_ENABLED=0, and CGO_ENABLED=0 go test runs this")
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 5 {
		t.Fatalf("the child has %d threads (%q); want its own and the 4 it holds", len(lines), out)
	}
	for _, line := range lines {
		if !strings.HasSuffix(line, " 1") {
			t.Errorf("thread %s: NoNewPrivs is not 1; every thread of init must hold no_new_privs", line)
		}
	}
}
