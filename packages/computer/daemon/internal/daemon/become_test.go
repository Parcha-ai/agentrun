package daemon

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/nocgo"
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

// BecomeChildArg runs this test binary as becomeChild (see TestMain); StatusChildArg as statusChild.
const (
	BecomeChildArg = "become-on-every-thread"
	StatusChildArg = "print-status"
)

const (
	noCapabilities = "0000000000000000"
	capSetpcap     = 8
	linuxCapV3     = 0x20080522
)

// statusFields are the lines of /proc/<pid>/status the privilege drop answers for.
var statusFields = []string{"Uid", "Gid", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"}

// statusOf reads path, a /proc status file, as "Field=value" for each of statusFields, space-separated.
func statusOf(path string) (string, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	values := map[string]string{}
	for line := range strings.Lines(string(text)) {
		name, value, found := strings.Cut(line, ":")
		if found {
			values[name] = strings.Join(strings.Fields(value), ",")
		}
	}
	fields := make([]string, 0, len(statusFields))
	for _, name := range statusFields {
		value, found := values[name]
		if !found {
			value = "missing"
		}
		fields = append(fields, name+"="+value)
	}
	return strings.Join(fields, " "), nil
}

// statusChild prints its own status fields: a program started by a process that dropped its privileges.
func statusChild() int {
	status, err := statusOf("/proc/self/status")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(status)
	return 0
}

type testCapHeader struct {
	version uint32
	pid     int32
}

type testCapData struct{ effective, permitted, inheritable uint32 }

var (
	testCapsetHeader = testCapHeader{version: linuxCapV3}
	testCapsetData   [2]testCapData
)

const (
	capNetBindService = 10
	prCapAmbientTest  = 47
	prCapAmbientRaise = 2
)

// prepareCapabilities sets every thread up as how asks before Become: "no-setpcap" takes CAP_SETPCAP out of the effective
// and permitted sets and leaves the rest, a root process that holds capabilities but cannot empty its bounding set;
// "ambient" adds CAP_NET_BIND_SERVICE to the inheritable and ambient sets, which a uid change alone does not clear from
// root. "plain" leaves the process as it started.
func prepareCapabilities(how string) error {
	if how == "plain" {
		return nil
	}
	header := testCapHeader{version: linuxCapV3}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_CAPGET, uintptr(unsafe.Pointer(&header)), uintptr(unsafe.Pointer(&testCapsetData[0])), 0); errno != 0 {
		return fmt.Errorf("capget: %w", errno)
	}
	switch how {
	case "no-setpcap":
		testCapsetData[0].effective &^= 1 << capSetpcap
		testCapsetData[0].permitted &^= 1 << capSetpcap
	case "ambient":
		testCapsetData[0].inheritable |= 1 << capNetBindService
	default:
		return fmt.Errorf("no such preparation %q", how)
	}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&testCapsetHeader)), uintptr(unsafe.Pointer(&testCapsetData[0])), 0); errno != 0 {
		return fmt.Errorf("capset: %w", errno)
	}
	if how == "ambient" {
		if _, _, errno := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prCapAmbientTest, prCapAmbientRaise, capNetBindService, 0, 0, 0); errno != 0 {
			return fmt.Errorf("raising an ambient capability: %w", errno)
		}
	}
	return nil
}

// becomeChild holds threads of its own, then calls Become(uid:gid, home, socket) with args uid:gid, home, socket and how
// to prepare the capabilities first (see prepareCapabilities); with "none" for uid:gid it calls Unprivileged. It prints "refused <error>" and exits 3 when Become
// refuses; otherwise "thread <tid> <fields>" for each of its threads and "program <fields>" for a program it starts.
func becomeChild(args []string) int {
	if len(args) != 4 {
		fmt.Fprintln(os.Stderr, "become child: uid:gid home socket plain|no-setpcap|ambient")
		return 2
	}
	var uid, gid int
	if _, err := fmt.Sscanf(args[0], "%d:%d", &uid, &gid); err != nil && args[0] != "none" {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
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
	if err := prepareCapabilities(args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	drop := func() error { return Become(uid, gid, args[1], args[2]) }
	if args[0] == "none" {
		drop = Unprivileged
	}
	if err := drop(); err != nil {
		fmt.Println("refused", err)
		return 3
	}
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	for _, task := range tasks {
		status, err := statusOf(filepath.Join("/proc/self/task", task.Name(), "status"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println("thread", task.Name(), status)
	}
	program := exec.Command(os.Args[0], StatusChildArg)
	program.Stderr = os.Stderr
	out, err := program.Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "the program:", err)
		return 1
	}
	fmt.Print("program ", string(out))
	return 0
}

// capabilitiesOfThisProcess reads this test process's CapEff and CapBnd.
func capabilitiesOfThisProcess(t *testing.T) (effective, bounding uint64) {
	t.Helper()
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	for line := range strings.Lines(string(status)) {
		name, value, _ := strings.Cut(line, ":")
		number, _ := strconv.ParseUint(strings.TrimSpace(value), 16, 64)
		switch name {
		case "CapEff":
			effective = number
		case "CapBnd":
			bounding = number
		}
	}
	return effective, bounding
}

// The drop needs a test binary without cgo, as computerd is built: with cgo every refusal is ENOTSUP, and none is tested.
func TestThisTestBinaryLinksNoCgo(t *testing.T) {
	nocgo.Require(t)
	if cgoBuild {
		t.Fatal("this test binary links cgo: the drop is tested only in one without cgo, as computerd is built")
	}
}

// needsRootWithCapabilities skips a test of the root path unless this process is root, holds CAP_SETPCAP and has a
// bounding set to empty. As another user the root path runs in a container (README: the daemon's tests as root).
func needsRootWithCapabilities(t *testing.T) {
	t.Helper()
	nocgo.Require(t)
	effective, bounding := capabilitiesOfThisProcess(t)
	if os.Geteuid() != 0 || effective&(1<<capSetpcap) == 0 || bounding == 0 {
		t.Skipf("runs as uid %d with CapEff %016x and CapBnd %016x: the root path needs root with CAP_SETPCAP and a bounding set, as a container gives one; run this test binary as root in a container", os.Geteuid(), effective, bounding)
	}
}

func runBecomeChild(t *testing.T, user, how string) (string, int) {
	t.Helper()
	home := filepath.Join(t.TempDir(), "work")
	socket := filepath.Join(t.TempDir(), "run", "computerd.sock")
	cmd := exec.Command(os.Args[0], BecomeChildArg, user, home, socket, how)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	var exit *exec.ExitError
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 3) {
		t.Fatalf("the child as %s: %v; stdout %q, stderr %s", user, err, out, stderr.String())
	}
	if exit != nil {
		return string(out), exit.ExitCode()
	}
	return string(out), 0
}

// checkNothingLeft checks the child's lines: every thread and the program it started are uid:gid, hold no capability in
// any set and have no_new_privs set.
func checkNothingLeft(t *testing.T, what, uid, gid, out string) {
	t.Helper()
	want := fmt.Sprintf("Uid=%[1]s,%[1]s,%[1]s,%[1]s Gid=%[2]s,%[2]s,%[2]s,%[2]s CapInh=%[3]s CapPrm=%[3]s CapEff=%[3]s CapBnd=%[3]s CapAmb=%[3]s NoNewPrivs=1", uid, gid, noCapabilities)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	threads, wrong := 0, []string{}
	for _, line := range lines {
		kind, rest, _ := strings.Cut(line, " ")
		if kind == "thread" {
			threads++
			_, rest, _ = strings.Cut(rest, " ")
		}
		if rest != want {
			wrong = append(wrong, line)
		}
	}
	if len(wrong) > 0 {
		t.Errorf("%s: %d of %d lines hold more than they should; the first:\n  %s\n  want %s", what, len(wrong), len(lines), wrong[0], want)
	}
	if threads < 5 || !strings.HasPrefix(lines[len(lines)-1], "program ") {
		t.Errorf("%s: %d threads and no program line in %q; want its own thread, the 4 it holds and the program it started", what, threads, out)
	}
}

func TestBecomeLeavesNoCapabilityOnAnyThreadRootIncluded(t *testing.T) {
	needsRootWithCapabilities(t)
	for _, user := range []string{"0:0", "1000:1000"} {
		for _, how := range []string{"plain", "ambient"} {
			out, code := runBecomeChild(t, user, how)
			if code != 0 {
				t.Errorf("Become(%s), %s: refused: %s", user, how, out)
				continue
			}
			uid, gid, _ := strings.Cut(user, ":")
			checkNothingLeft(t, fmt.Sprintf("Become(%s), %s", user, how), uid, gid, out)
		}
	}
}

func TestUnprivilegedLeavesRootNoCapabilityOnAnyThread(t *testing.T) {
	needsRootWithCapabilities(t)
	for _, how := range []string{"plain", "ambient"} {
		out, code := runBecomeChild(t, "none", how)
		if code != 0 {
			t.Errorf("Unprivileged, %s: refused: %s", how, out)
			continue
		}
		checkNothingLeft(t, "Unprivileged as root, "+how, "0", "0", out)
	}
	out, code := runBecomeChild(t, "none", "no-setpcap")
	if code != 3 || !strings.Contains(out, "bounding set") || !strings.Contains(out, "operation not permitted") {
		first, _, _ := strings.Cut(out, "\n")
		t.Errorf("Unprivileged as root without CAP_SETPCAP: exit %d, %q; want a refusal that names the bounding set and EPERM", code, first)
	}
}

// As a user with a bounding set and no CAP_SETPCAP, as go test runs on a host: the drop cannot be done, so it is refused.
func TestUnprivilegedRefusesABoundingSetItCannotEmpty(t *testing.T) {
	nocgo.Require(t)
	effective, bounding := capabilitiesOfThisProcess(t)
	if effective&(1<<capSetpcap) != 0 || bounding == 0 {
		t.Skipf("CapEff %016x, CapBnd %016x: this process can empty its bounding set", effective, bounding)
	}
	out, code := runBecomeChild(t, "none", "plain")
	if code != 3 || !strings.Contains(out, "bounding set") || !strings.Contains(out, "operation not permitted") {
		t.Fatalf("Unprivileged with CapBnd %016x and no CAP_SETPCAP: exit %d, %q; want a refusal that names the bounding set and EPERM", bounding, code, out)
	}
}

func TestBecomeRefusesWhenItCannotEmptyTheBoundingSet(t *testing.T) {
	needsRootWithCapabilities(t)
	for _, user := range []string{"0:0", "1000:1000"} {
		out, code := runBecomeChild(t, user, "no-setpcap")
		if code != 3 || !strings.Contains(out, "bounding set") || !strings.Contains(out, "operation not permitted") {
			first, _, _ := strings.Cut(out, "\n")
			t.Errorf("Become(%s) without CAP_SETPCAP: exit %d, %q; want a refusal that names the bounding set and EPERM", user, code, first)
		}
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
