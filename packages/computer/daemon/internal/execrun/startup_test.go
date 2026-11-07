package execrun_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// stallArg, after GuardCommand, starts the test binary as a guard that stalls (stallingGuard).
const stallArg = "stall-before-pid"

// stallingGuard plays a guard that stalls before it reports the program's pid, as one whose exec hangs on a stalled
// filesystem would. It starts a child of its own, writes its pid and the child's to the fifo, then reads its control
// pipe (the spec and whatever follows) until the daemon lets go of it.
func stallingGuard(fifo string) int {
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	// A guard has an empty environment, so no PATH to look sleep up in.
	child := exec.Command("/bin/sleep", "300")
	if child.Start() != nil {
		return 125
	}
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		return 125
	}
	_, _ = fmt.Fprintf(f, "%d %d\n", os.Getpid(), child.Process.Pid)
	_ = f.Close()
	buf := make([]byte, 4096)
	for {
		if n, err := syscall.Read(3, buf); n <= 0 && !errors.Is(err, syscall.EINTR) {
			return 125
		}
	}
}

// pidfd refers to one process, opened while it runs, so no later check or kill reaches another that took its pid.
type pidfd struct {
	pid, fd int
}

// The pidfd system calls have one number on every Linux architecture.
const (
	sysPidfdSendSignal = 424
	sysPidfdOpen       = 434
)

func openPidfd(t *testing.T, pid int) pidfd {
	t.Helper()
	fd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(pid), 0, 0)
	if errno != 0 {
		t.Fatalf("cannot open a pidfd on process %d: %v", pid, errno)
	}
	p := pidfd{pid: pid, fd: int(fd)}
	// After a test that failed, nothing it started is left running.
	t.Cleanup(func() {
		_, _, _ = syscall.Syscall6(sysPidfdSendSignal, uintptr(p.fd), uintptr(syscall.SIGKILL), 0, 0, 0, 0)
		_ = syscall.Close(p.fd)
	})
	return p
}

// ended waits up to within for the process to end: its pidfd turns readable once it is a zombie or reaped. Then /proc
// must agree: no entry, a zombie (Z), or dead (X), which is what a zombie reads as while its parent reaps it.
func (p pidfd) ended(within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		var set syscall.FdSet
		set.Bits[p.fd/64] |= 1 << (uint(p.fd) % 64)
		tv := syscall.NsecToTimeval(max(time.Until(deadline), 0).Nanoseconds())
		n, err := syscall.Select(p.fd+1, &set, nil, nil, &tv)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || n == 0 {
			return false
		}
		break
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(p.pid) + "/stat")
	if err != nil {
		return true
	}
	fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
	return len(fields) > 0 && (fields[0] == "Z" || fields[0] == "X")
}

// stallGuards makes every guard Start starts from now on stall before it reports the program's pid. The function it
// returns waits for the next guard to stall, and returns it and its child.
func stallGuards(t *testing.T) func() (guard, child pidfd) {
	t.Helper()
	fifo := filepath.Join(t.TempDir(), "stalled")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	execrun.SetGuardArgs(t, func(execrun.Program) []string { return []string{stallArg, fifo} })
	return func() (pidfd, pidfd) {
		t.Helper()
		got := make(chan []int, 1)
		go func() {
			data, _ := os.ReadFile(fifo)
			var pids []int
			for _, f := range strings.Fields(string(data)) {
				if pid, err := strconv.Atoi(f); err == nil {
					pids = append(pids, pid)
				}
			}
			got <- pids
		}()
		select {
		case pids := <-got:
			if len(pids) != 2 {
				t.Fatalf("the stalled guard sent %v, not its pid and its child's", pids)
			}
			return openPidfd(t, pids[0]), openPidfd(t, pids[1])
		case <-time.After(patience):
			t.Fatal("no guard stalled")
		}
		return pidfd{}, pidfd{}
	}
}

type runOutcome struct {
	res execrun.Result
	err error
}

func runInBackground(ctx context.Context, spec execrun.Spec) <-chan runOutcome {
	done := make(chan runOutcome, 1)
	go func() {
		res, err := execrun.Run(ctx, spec)
		done <- runOutcome{res, err}
	}()
	return done
}

// stalledAway says how the guard and its child fared: both must have ended, and the guard been reaped.
func stalledAway(t *testing.T, guard, child pidfd) {
	t.Helper()
	if !guard.ended(patience) || slices.Contains(execrun.Guards(), guard.pid) {
		t.Errorf("the stalled guard, process %d, was not ended and reaped", guard.pid)
	}
	if !child.ended(patience) {
		t.Errorf("the stalled guard's child, process %d, still runs", child.pid)
	}
}

// A run whose guard stalls before it reports the program's pid still times out at timeoutMs: the guard and everything
// under it are killed and reaped, and the result says it timed out.
func TestARunWhoseGuardStallsBeforeItStartsTheProgramTimesOut(t *testing.T) {
	stalled := stallGuards(t)
	done := runInBackground(context.Background(), execrun.Spec{Argv: []string{"true"}, Timeout: 200 * time.Millisecond})
	guard, child := stalled()
	var r runOutcome
	select {
	case r = <-done:
	case <-time.After(patience):
		t.Fatalf("exec.run with timeoutMs 200 still waits, %v on, for a guard that never reported", patience)
	}
	if r.err != nil || !r.res.TimedOut {
		t.Fatalf("want a result that timed out, got %+v, %v", r.res, r.err)
	}
	stalledAway(t, guard, child)
}

// A run cancelled while its guard stalls before it reports the program's pid is aborted at once, not left waiting.
func TestARunCancelledWhileItsGuardStallsIsAborted(t *testing.T) {
	stalled := stallGuards(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runInBackground(ctx, execrun.Spec{Argv: []string{"true"}, Timeout: time.Hour})
	guard, child := stalled()
	cancel()
	var r runOutcome
	select {
	case r = <-done:
	case <-time.After(patience):
		t.Fatalf("a cancelled exec.run still waits, %v on, for a guard that never reported", patience)
	}
	if r.err == nil || kindOf(t, r.err) != rpc.KindAborted {
		t.Fatalf("want an aborted error, got %+v, %v", r.res, r.err)
	}
	stalledAway(t, guard, child)
}

// A start with no deadline, as process.start's, cancelled while its guard stalls before it reports the program's pid is
// aborted at once, not left waiting.
func TestAStartCancelledWhileItsGuardStallsIsAborted(t *testing.T) {
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	stalled := stallGuards(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan startOutcome, 1)
	go func() {
		g, err := execrun.Start(ctx, execrun.Program{Argv: []string{"true"}}, nil, null, null)
		done <- startOutcome{g, err}
	}()
	guard, child := stalled()
	cancel()
	var r startOutcome
	select {
	case r = <-done:
	case <-time.After(patience):
		t.Fatalf("a cancelled start still waits, %v on, for a guard that never reported", patience)
	}
	if r.err == nil || kindOf(t, r.err) != rpc.KindAborted {
		t.Fatalf("want an aborted error, got %v, %v", r.g, r.err)
	}
	stalledAway(t, guard, child)
}
