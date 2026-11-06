package execrun_test

import (
	"os"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
)

// TestMain runs the guard when Run starts this test binary as one, as computerd does.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == execrun.GuardCommand {
		os.Exit(execrun.Guard())
	}
	os.Exit(m.Run())
}
