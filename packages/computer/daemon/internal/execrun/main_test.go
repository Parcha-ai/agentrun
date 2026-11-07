package execrun_test

import (
	"os"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
)

// TestMain runs the guard when Run starts this test binary as one, as computerd does, or a guard that stalls when a
// test asks for one.
func TestMain(m *testing.M) {
	if len(os.Args) == 4 && os.Args[1] == execrun.GuardCommand && os.Args[2] == stallArg {
		os.Exit(stallingGuard(os.Args[3]))
	}
	if len(os.Args) == 2 && os.Args[1] == execrun.GuardCommand {
		os.Exit(execrun.Guard())
	}
	os.Exit(m.Run())
}
