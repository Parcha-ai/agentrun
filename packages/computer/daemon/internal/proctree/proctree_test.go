package proctree

import (
	"os"
	"testing"
)

// A pid with another start time than the one recorded names another process, one that got the pid once the first
// ended: that first process runs no more.
func TestRunningIsFalseForAPidWhoseStartTimeChanged(t *testing.T) {
	self := os.Getpid()
	started, ok := Started(self)
	if !ok {
		t.Fatalf("cannot read the start time of process %d", self)
	}
	if !Running(self, started) {
		t.Fatalf("process %d, this test, does not run", self)
	}
	if Running(self, started+1) {
		t.Fatalf("process %d reads as running with a start time it does not have", self)
	}
}
