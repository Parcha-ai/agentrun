package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/nocgo"
)

// argsEnv makes the test binary run computerd's main with these arguments (JSON), as a process of its own.
const argsEnv = "COMPUTERD_TEST_ARGS"

func TestMain(m *testing.M) {
	if args := os.Getenv(argsEnv); args != "" {
		os.Args = []string{"computerd"}
		if err := json.Unmarshal([]byte(args), &os.Args); err != nil {
			os.Exit(99)
		}
		main()
		os.Exit(0)
	}
	// computerd is built without cgo, and init's start is tested in a test binary without it: a plain go test, with
	// cgo on, runs these tests in one built again with CGO_ENABLED=0.
	os.Exit(nocgo.Run(m))
}

// computerd runs main with args, not as PID 1, and returns its exit code and stderr; it is killed after bound.
func computerd(t *testing.T, bound time.Duration, args ...string) (int, string) {
	t.Helper()
	encoded, _ := json.Marshal(append([]string{"computerd"}, args...))
	ctx, cancel := context.WithTimeout(context.Background(), bound)
	defer cancel()
	// Init refuses a socket directory others may enter; t.TempDir's mode follows the umask.
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, os.Args[0])
	cmd.Env = append(os.Environ(), argsEnv+"="+string(encoded), daemon.SocketEnv+"="+filepath.Join(dir, "computerd.sock"))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("computerd %q still ran after %v; stderr: %s", args, bound, stderr.String())
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), stderr.String()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, stderr.String()
}

func TestInitRefusesToStartWithoutADeadline(t *testing.T) {
	for _, args := range [][]string{
		{"init"},
		{"init", "--deadline"},
		{"init", "--deadline", ""},
		{"init", "--deadline", "tomorrow"},
		{"init", "--deadline", "2026-11-06"},
		{"init", "--deadline", "2026-11-06T10:00:00Z", "extra"},
	} {
		code, stderr := computerd(t, 30*time.Second, args...)
		if code == 0 {
			t.Errorf("computerd %q exited 0; want a refusal", args)
		}
		if !strings.Contains(stderr, "--deadline") || !strings.Contains(stderr, "RFC 3339") {
			t.Errorf("computerd %q: stderr does not say why in words: %q", args, stderr)
		}
	}
}

// The tests of init's start need a test binary without cgo, as computerd is built: with cgo, init refuses to start for
// that (ENOTSUP), and the refusal for a capability it cannot drop (EPERM) and the deadline go untested.
func TestThisTestBinaryLinksNoCgo(t *testing.T) {
	nocgo.Require(t)
	if cgoBuild {
		t.Fatal("this test binary links cgo: init's start is tested only in one without cgo, as computerd is built")
	}
}

// dropsHere says whether init, started as this test process is, can leave itself no capability: it holds CAP_SETPCAP
// or has an empty bounding set. When it cannot, it refuses to start, and why is returned.
func dropsHere(t *testing.T) (bool, string) {
	t.Helper()
	nocgo.Require(t)
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	var effective, bounding uint64
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
	if bounding != 0 && effective&(1<<8) == 0 {
		return false, fmt.Sprintf("uid %d holds no CAP_SETPCAP and its bounding set is %016x", os.Geteuid(), bounding)
	}
	return true, ""
}

// refusedToStart checks that init, having taken its deadline, refused to start, in words, because it cannot drop a
// capability from its bounding set (EPERM): not for cgo (ENOTSUP), and not for its arguments.
func refusedToStart(t *testing.T, why string, code int, stderr string) {
	t.Helper()
	if code != 1 || !strings.Contains(stderr, "refuses to start") || !strings.Contains(stderr, "bounding set") || !strings.Contains(stderr, syscall.EPERM.Error()) {
		t.Fatalf("init here (%s): exit %d, stderr %q; want exit 1 and a refusal to start that names the bounding set and EPERM", why, code, stderr)
	}
	if strings.Contains(stderr, syscall.ENOTSUP.Error()) || strings.Contains(stderr, "--deadline") {
		t.Fatalf("init here (%s): stderr %q; want the refusal for the bounding set alone, with no ENOTSUP and no word on its deadline", why, stderr)
	}
}

func TestInitRefusesToStartWithACapabilityItCannotDrop(t *testing.T) {
	drops, why := dropsHere(t)
	if drops {
		t.Skip("init can drop every capability here; run as a user with a bounding set and no CAP_SETPCAP, as go test runs on a host")
	}
	code, stderr := computerd(t, 10*time.Second, "init", "--deadline", time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano))
	refusedToStart(t, why, code, stderr)
}

func TestInitEndsAtItsDeadline(t *testing.T) {
	deadline := time.Now().Add(500 * time.Millisecond)
	code, stderr := computerd(t, 30*time.Second, "init", "--deadline", deadline.UTC().Format(time.RFC3339Nano))
	if drops, why := dropsHere(t); !drops {
		// It took the deadline and refused to start, as it must here. Init's end at its deadline is
		// internal/daemon's TestInitEndsEveryProcessAtItsDeadlineAndExits0, and computerd's in the Docker live tests.
		refusedToStart(t, why, code, stderr)
		return
	}
	if code != 0 {
		t.Fatalf("exit code %d at the deadline, want 0; stderr: %s", code, stderr)
	}
	if time.Now().Before(deadline) {
		t.Fatalf("init ended before its deadline; stderr: %s", stderr)
	}
	if !strings.Contains(stderr, "deadline") {
		t.Errorf("init did not say it ended at its deadline: %q", stderr)
	}
}

func TestInitTakesTheProvidersDeadline(t *testing.T) {
	// The form JavaScript's toISOString writes, which the provider passes.
	code, stderr := computerd(t, 30*time.Second, "init", "--deadline", time.Now().Add(-time.Second).UTC().Format("2006-01-02T15:04:05.000Z"))
	if drops, why := dropsHere(t); !drops {
		// It took the deadline in that form, and refused to start only for the bounding set.
		refusedToStart(t, why, code, stderr)
		return
	}
	if code != 0 {
		t.Fatalf("exit code %d, want 0 at a deadline already past; stderr: %s", code, stderr)
	}
}

// computerdOut runs main with args and returns its exit code, stdout and stderr; it is killed after bound.
func computerdOut(t *testing.T, bound time.Duration, args ...string) (int, string, string) {
	t.Helper()
	encoded, _ := json.Marshal(append([]string{"computerd"}, args...))
	ctx, cancel := context.WithTimeout(context.Background(), bound)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0])
	cmd.Env = append(os.Environ(), argsEnv+"="+string(encoded))
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("computerd %q still ran after %v; stderr: %s", args, bound, stderr.String())
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), stdout.String(), stderr.String()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, stdout.String(), stderr.String()
}

func TestInitRefusesAUserThatIsNotUidAndGidInNumbers(t *testing.T) {
	deadline := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	for _, args := range [][]string{
		{"init", "--deadline", deadline, "--user"},
		{"init", "--deadline", deadline, "--user", "alice"},
		{"init", "--deadline", deadline, "--user", "1000"},
		{"init", "--deadline", deadline, "--user", "1000:"},
		{"init", "--deadline", deadline, "--user", "-1:0"},
		{"init", "--deadline", deadline, "--user", "1000:1000", "--user", "0:0"},
	} {
		code, stderr := computerd(t, 30*time.Second, args...)
		if code == 0 {
			t.Errorf("computerd %q exited 0; want a refusal", args)
		}
		if !strings.Contains(stderr, "--user") || !strings.Contains(stderr, "uid:gid") {
			t.Errorf("computerd %q: stderr does not say why in words: %q", args, stderr)
		}
	}
}

func TestInitTakesTheMostItsDeadlineMayMoveTo(t *testing.T) {
	past := time.Now().Add(-time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
	later := time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	code, stderr := computerd(t, 30*time.Second, "init", "--deadline", past, "--max-deadline", later)
	if drops, why := dropsHere(t); !drops {
		// It took both times, and refused to start only for the bounding set.
		refusedToStart(t, why, code, stderr)
	} else if code != 0 {
		t.Fatalf("exit code %d with --max-deadline, want 0 at a deadline already past; stderr: %s", code, stderr)
	}
	for _, args := range [][]string{
		{"init", "--deadline", later, "--max-deadline"},
		{"init", "--deadline", later, "--max-deadline", "never"},
		{"init", "--deadline", later, "--max-deadline", past},
		{"init", "--max-deadline", later, "--deadline", later, "extra"},
		{"init", "--deadline", later, "--max-deadline", later, "--max-deadline", later},
	} {
		code, stderr := computerd(t, 30*time.Second, args...)
		if code == 0 {
			t.Errorf("computerd %q exited 0; want a refusal", args)
		}
		if !strings.Contains(stderr, "--max-deadline") {
			t.Errorf("computerd %q: stderr does not say why in words: %q", args, stderr)
		}
	}
}

func TestInitWithAUserMustStartAsRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("runs as root: init would drop this test's privileges; the drop is a live case")
	}
	deadline := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	code, stderr := computerd(t, 30*time.Second, "init", "--user", "1000:1000", "--deadline", deadline)
	if code == 0 || !strings.Contains(stderr, "root") {
		t.Fatalf("init --user as uid %d: exit %d, stderr %q; want a refusal that says init must start as root", os.Geteuid(), code, stderr)
	}
}

func TestProbePrintsOneJSONLineOfWhatItReached(t *testing.T) {
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	address := listener.Addr().String()
	code, stdout, stderr := computerdOut(t, 30*time.Second, "probe", "--connect", address)
	if code != 0 {
		t.Fatalf("probe: exit %d, stderr %q", code, stderr)
	}
	var report struct {
		UID     *int     `json:"uid"`
		GID     *int     `json:"gid"`
		Kernel  string   `json:"kernel"`
		Reached []string `json:"reached"`
	}
	if err := json.Unmarshal([]byte(stdout), &report); err != nil || strings.Count(stdout, "\n") != 1 {
		t.Fatalf("probe wrote %q; want one JSON line (%v)", stdout, err)
	}
	if report.UID == nil || *report.UID != os.Getuid() || report.GID == nil || *report.GID != os.Getgid() || report.Kernel == "" {
		t.Fatalf("probe reported %+v; want this process's uid and gid and the kernel", report)
	}
	if len(report.Reached) != 1 || report.Reached[0] != address {
		t.Fatalf("probe reached %q; want [%s]", report.Reached, address)
	}
}

func TestProbeRefusesATargetThatIsNotHostAndPort(t *testing.T) {
	for _, args := range [][]string{
		{"probe", "--connect"},
		{"probe", "--connect", "example.com"},
		{"probe", "example.com:443"},
	} {
		code, _, stderr := computerdOut(t, 30*time.Second, args...)
		if code != 2 || !strings.Contains(stderr, "host:port") {
			t.Errorf("computerd %q: exit %d, stderr %q; want exit 2 and a refusal in words", args, code, stderr)
		}
	}
}
