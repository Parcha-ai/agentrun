package windowmanager

import (
	"os/exec"
	"strings"
	"testing"
)

// Once the start is reaped its pid is free for the kernel to give another process, which init's sweep must not spare:
// Pid says 0 from then on, and the fact says how the start ended.
func TestAReapedStartLeavesNoPidForTheSweepToSpare(t *testing.T) {
	m := New(":99", t.TempDir(), false, 0, 0)
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	m.pid = cmd.Process.Pid
	drained := make(chan struct{})
	close(drained)
	m.wait(cmd, drained)
	if pid := m.Pid(); pid != 0 {
		t.Fatalf("Pid after the start was reaped: %d; want 0", pid)
	}
	if fact := m.Fact(); fact.State != Ended || !strings.Contains(fact.Why, "ended with exit code 0 before the display answered on :99") {
		t.Fatalf("the fact after the start was reaped: %+v; want ended, in words that say how and when", fact)
	}
}
