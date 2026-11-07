package execrun

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/proctree"
)

// Once the guard was reaped its pid is free, and the kernel may give it to another process: killGuard must not signal
// that pid then. Here a live bystander stands in for the process that got the recycled pid.
func TestKillGuardSparesThePidOnceTheGuardWasReaped(t *testing.T) {
	bystander := exec.Command("sleep", "60")
	if err := bystander.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bystander.Process.Kill() })
	done := make(chan struct{})
	close(done)
	g := &Guarded{guard: &exec.Cmd{Process: bystander.Process}, done: done}
	if err := killGuard(g); err != nil {
		t.Fatalf("killGuard on a reaped guard: %v", err)
	}
	// SIGKILL lands asynchronously: wait for the bystander, bounded. Dying in that time means killGuard signalled it.
	ended := make(chan error, 1)
	go func() { ended <- bystander.Wait() }()
	select {
	case err := <-ended:
		t.Fatalf("killGuard signalled pid %d after its guard was reaped: %v", bystander.Process.Pid, err)
	case <-time.After(2 * time.Second):
	}
}

// guardWithChild starts sh, standing in for a guard, with one child under it, and returns them and the child's start
// time. The child is killed after the test should it still run.
func guardWithChild(t *testing.T) (g *Guarded, child int, started uint64) {
	t.Helper()
	sh := exec.Command("/bin/sh", "-c", "/bin/sleep 300 & wait")
	if err := sh.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = sh.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		_ = sh.Process.Kill()
		<-done
	})
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if under := proctree.Descendants(sh.Process.Pid); len(under) == 1 {
			child = under[0]
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the shell, process %d, started no child", sh.Process.Pid)
		}
	}
	started, ok := proctree.Started(child)
	if !ok {
		t.Fatalf("cannot read the start time of process %d", child)
	}
	t.Cleanup(func() {
		if proctree.Running(child, started) {
			_ = syscall.Kill(child, syscall.SIGKILL)
		}
	})
	return &Guarded{guard: sh, done: done}, child, started
}

// setKillDescendant has killGuard call kill in place of sending SIGKILL to a descendant, for the test's duration.
func setKillDescendant(t *testing.T, kill func(pid int)) {
	killDescendant = kill
	t.Cleanup(func() { killDescendant = nil })
}

// SIGKILL lands asynchronously: a process sent it may run on for a moment. killGuard returns only once every descendant
// it sent SIGKILL has ended. Here the SIGKILL lands 300 ms after killGuard sends it, every time.
func TestKillGuardReturnsOnlyOnceEveryDescendantHasEnded(t *testing.T) {
	g, child, started := guardWithChild(t)
	setKillDescendant(t, func(pid int) {
		time.AfterFunc(300*time.Millisecond, func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	})
	if err := killGuard(g); err != nil {
		t.Fatalf("killGuard: %v", err)
	}
	if proctree.Running(child, started) {
		t.Fatalf("killGuard returned while process %d, a descendant it sent SIGKILL, still runs", child)
	}
}

// A descendant still running once the wait for it is over makes killGuard fail, naming it.
func TestKillGuardFailsNamingADescendantThatOutlivesItsSIGKILL(t *testing.T) {
	g, child, _ := guardWithChild(t)
	setKillDescendant(t, func(int) {})
	descendantsTimeout = 200 * time.Millisecond
	t.Cleanup(func() { descendantsTimeout = cleanupTimeout })
	err := killGuard(g)
	if err == nil || !strings.Contains(err.Error(), strconv.Itoa(child)) {
		t.Fatalf("want an error naming process %d, which still runs, got %v", child, err)
	}
}
