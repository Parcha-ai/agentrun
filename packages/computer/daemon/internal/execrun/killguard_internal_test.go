package execrun

import (
	"os/exec"
	"testing"
	"time"
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
