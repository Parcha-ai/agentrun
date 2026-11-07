package execrun_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

func run(t *testing.T, spec execrun.Spec) execrun.Result {
	t.Helper()
	if spec.Timeout == 0 {
		spec.Timeout = 10 * time.Second
	}
	res, err := execrun.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run(%q): %v", spec.Argv, err)
	}
	return res
}

func kindOf(t *testing.T, err error) rpc.Kind {
	t.Helper()
	var e *rpc.Error
	if !errors.As(err, &e) {
		t.Fatalf("want an *rpc.Error, got %v", err)
	}
	return e.Kind
}

// gone waits until pid is no process or a zombie, which is a process that has ended.
func gone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		if stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
			if fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:])); len(fields) > 0 && fields[0] == "Z" {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d is still running", pid)
}

func pidOf(t *testing.T, out []byte) int {
	t.Helper()
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("no pid in %q", out)
	}
	return pid
}

func TestExitCodeAndSplitStreams(t *testing.T) {
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", "echo out; echo err >&2; exit 3"}})
	if res.ExitCode == nil || *res.ExitCode != 3 || string(res.Stdout) != "out\n" || string(res.Stderr) != "err\n" || res.TimedOut || res.Truncated {
		t.Fatalf("unexpected result %+v (stdout %q stderr %q)", res, res.Stdout, res.Stderr)
	}
}

func TestArgvIsNeverAShell(t *testing.T) {
	arg := "$(id) `id`; echo no > x | cat && *"
	res := run(t, execrun.Spec{Argv: []string{"printf", "%s|%s", "a b", arg}, Cwd: t.TempDir()})
	if want := "a b|" + arg; string(res.Stdout) != want {
		t.Fatalf("stdout %q, want %q", res.Stdout, want)
	}
}

func TestTimeoutKillsTheWholeGroup(t *testing.T) {
	start := time.Now()
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", "sleep 60 & echo $!; wait"}, Timeout: 300 * time.Millisecond})
	if !res.TimedOut || res.ExitCode != nil || res.Signal != "TERM" {
		t.Fatalf("want timed out by SIGTERM, got %+v", res)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("took %v, want the group to end on SIGTERM", time.Since(start))
	}
	gone(t, pidOf(t, res.Stdout))
}

func TestTimeoutEscalatesToSIGKILL(t *testing.T) {
	start := time.Now()
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", "trap '' TERM; sleep 60 & echo $!; wait"}, Timeout: 200 * time.Millisecond})
	elapsed := time.Since(start)
	if !res.TimedOut || res.Signal != "KILL" || elapsed < 2*time.Second || elapsed > 30*time.Second {
		t.Fatalf("want SIGKILL 2 s after SIGTERM, got %+v after %v", res, elapsed)
	}
	gone(t, pidOf(t, res.Stdout))
}

func TestCancelKillsTheGroupAndIsAborted(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pid")
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	_, err := execrun.Run(ctx, execrun.Spec{Argv: []string{"sh", "-c", "sleep 60 & echo $! > " + pidFile + "; wait"}, Timeout: 10 * time.Second})
	if kindOf(t, err) != rpc.KindAborted {
		t.Fatalf("want aborted, got %v", err)
	}
	data, readErr := os.ReadFile(pidFile)
	if readErr != nil {
		t.Fatal(readErr)
	}
	gone(t, pidOf(t, data))
}

func TestWhatTheProgramLeavesBehindIsKilled(t *testing.T) {
	start := time.Now()
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"}})
	if res.ExitCode == nil || *res.ExitCode != 0 || time.Since(start) > 30*time.Second {
		t.Fatalf("want exit 0 at once, got %+v after %v", res, time.Since(start))
	}
	gone(t, pidOf(t, res.Stdout))
}

func TestOutputIsTruncatedAndTheProgramStillEnds(t *testing.T) {
	thousand := 1000
	res := run(t, execrun.Spec{Argv: []string{"head", "-c", "200000", "/dev/zero"}, MaxOutput: &thousand})
	if len(res.Stdout) != 1000 || !res.Truncated || res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("want 1000 bytes, truncated, exit 0; got %d bytes %+v", len(res.Stdout), res)
	}
}

func TestEnvAddsToAMinimalDefault(t *testing.T) {
	t.Setenv("COMPUTERD_TEST_SECRET", "leak")
	res := run(t, execrun.Spec{Argv: []string{"env"}, Env: map[string]string{"FOO": "bar baz", "HOME": "/tmp"}})
	out := "\n" + string(res.Stdout)
	for _, want := range []string{"\nFOO=bar baz\n", "\nHOME=/tmp\n", "\nPATH="} {
		if !strings.Contains(out, want) {
			t.Fatalf("env lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "COMPUTERD_TEST_SECRET") {
		t.Fatalf("the daemon's own environment leaked:\n%s", out)
	}
}

func TestPathComesFromTheGivenEnv(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "only-here"), []byte("#!/bin/sh\necho found\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	res := run(t, execrun.Spec{Argv: []string{"only-here"}, Env: map[string]string{"PATH": dir + ":/usr/bin:/bin"}})
	if string(res.Stdout) != "found\n" {
		t.Fatalf("stdout %q", res.Stdout)
	}
}

func TestCwd(t *testing.T) {
	dir := t.TempDir()
	res := run(t, execrun.Spec{Argv: []string{"pwd"}, Cwd: dir})
	if strings.TrimSpace(string(res.Stdout)) != dir {
		t.Fatalf("pwd %q, want %q", res.Stdout, dir)
	}
	_, err := execrun.Run(context.Background(), execrun.Spec{Argv: []string{"pwd"}, Cwd: filepath.Join(dir, "missing"), Timeout: time.Second})
	if kindOf(t, err) != rpc.KindNotFound {
		t.Fatalf("want not_found for a missing cwd, got %v", err)
	}
}

func TestMissingProgramIsNotFound(t *testing.T) {
	_, err := execrun.Run(context.Background(), execrun.Spec{Argv: []string{"computerd-no-such-program"}, Timeout: time.Second})
	if kindOf(t, err) != rpc.KindNotFound {
		t.Fatalf("want not_found, got %v", err)
	}
}

func TestUser(t *testing.T) {
	_, err := execrun.Run(context.Background(), execrun.Spec{Argv: []string{"id"}, User: "computerd-no-such-user", Timeout: time.Second})
	if kindOf(t, err) != rpc.KindNotFound {
		t.Fatalf("want not_found for an unknown user, got %v", err)
	}
	res := run(t, execrun.Spec{Argv: []string{"id", "-u"}, User: strconv.Itoa(os.Getuid())})
	if strings.TrimSpace(string(res.Stdout)) != strconv.Itoa(os.Getuid()) {
		t.Fatalf("id -u %q as the daemon's own uid", res.Stdout)
	}
	if os.Geteuid() == 0 {
		t.Skip("running as root: switching users is allowed here")
	}
	_, err = execrun.Run(context.Background(), execrun.Spec{Argv: []string{"id"}, User: "0:0", Timeout: time.Second})
	if kindOf(t, err) != rpc.KindDenied || !strings.Contains(err.Error(), "CAP_SETUID") {
		t.Fatalf("want denied naming CAP_SETUID, got %v", err)
	}
}

// escape is a script that starts sleep 300 in a session of its own (setsid), so out of the program's process group, and
// prints its pid once it runs. With orphan set it is also double-forked: the subshell that started it exits at once, so
// it is no longer the program's descendant.
func escape(dir string, orphan bool) string {
	fifo := filepath.Join(dir, "pid")
	start := `setsid sh -c 'echo $$ > "$0"; exec sleep 300' "` + fifo + `" >/dev/null 2>&1 </dev/null &`
	if orphan {
		start = "( " + start + " );"
	}
	return `mkfifo "` + fifo + `"; ` + start + ` read pid < "` + fifo + `"; echo $pid`
}

// escapee is the pid an escape script printed. Should the test fail with it still running, it is killed at the end.
func escapee(t *testing.T, out []byte) int {
	t.Helper()
	pid := pidOf(t, out)
	t.Cleanup(func() {
		if cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); err == nil && string(cmdline) == "sleep\x00300\x00" {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	return pid
}

func TestASetsidChildDoesNotOutliveTheRun(t *testing.T) {
	start := time.Now()
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", escape(t.TempDir(), false)}})
	if res.ExitCode == nil || *res.ExitCode != 0 || time.Since(start) > 30*time.Second {
		t.Fatalf("want exit 0 at once, got %+v after %v", res, time.Since(start))
	}
	gone(t, escapee(t, res.Stdout))
}

func TestADoubleForkedSetsidChildDoesNotOutliveTheRun(t *testing.T) {
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", escape(t.TempDir(), true)}})
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("want exit 0, got %+v", res)
	}
	gone(t, escapee(t, res.Stdout))
}

func TestADoubleForkedSetsidChildDoesNotOutliveATimeout(t *testing.T) {
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", escape(t.TempDir(), true) + "; sleep 60"}, Timeout: 500 * time.Millisecond})
	if !res.TimedOut || res.Signal != "TERM" {
		t.Fatalf("want timed out by SIGTERM, got %+v", res)
	}
	gone(t, escapee(t, res.Stdout))
}

func TestARelativeProgramIsFoundInCwd(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "script"), []byte("#!/bin/sh\necho ran\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	res := run(t, execrun.Spec{Argv: []string{"./script"}, Cwd: dir})
	if string(res.Stdout) != "ran\n" {
		t.Fatalf("stdout %q", res.Stdout)
	}
}

func TestARelativePathEntryIsFoundInCwd(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bin", "only-in-cwd-bin"), []byte("#!/bin/sh\necho found\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	res := run(t, execrun.Spec{Argv: []string{"only-in-cwd-bin"}, Cwd: dir, Env: map[string]string{"PATH": "bin:/usr/bin:/bin"}})
	if string(res.Stdout) != "found\n" {
		t.Fatalf("stdout %q", res.Stdout)
	}
}

func TestASignalDeathIsReportedByName(t *testing.T) {
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", "kill -USR1 $$"}})
	if res.ExitCode != nil || res.Signal != "USR1" || res.TimedOut {
		t.Fatalf("want ended by SIGUSR1, got %+v", res)
	}
}

func TestAProgramThatCannotStartIsAnError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "garbage"), []byte{0, 1, 2, 3}, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := execrun.Run(context.Background(), execrun.Spec{Argv: []string{filepath.Join(dir, "garbage")}, Timeout: time.Second})
	if kindOf(t, err) != rpc.KindInvalid || !strings.Contains(err.Error(), "exec format error") {
		t.Fatalf("want invalid naming the exec format error, got %v", err)
	}
}

func TestTheDaemonsOwnHomeWinsOverItsPasswdEntry(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	res := run(t, execrun.Spec{Argv: []string{"sh", "-c", `printf %s "$HOME"`}})
	if got := string(res.Stdout); got != home {
		t.Fatalf("want HOME %q, the daemon's own, got %q", home, got)
	}
}
