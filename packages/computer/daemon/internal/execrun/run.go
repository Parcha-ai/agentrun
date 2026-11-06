// Package execrun runs one program to its end: argv only, never a shell, in a process group of its own.
package execrun

import (
	"context"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// MaxOutput is the most bytes kept of each stream. Two full streams, in base64, fit one 1 MiB reply line.
const MaxOutput = 360 << 10

// KillGrace is how long a group has between SIGTERM and SIGKILL.
const KillGrace = 2 * time.Second

// Spec is one run.
type Spec struct {
	Argv      []string
	Cwd       string
	Env       map[string]string
	User      string
	Timeout   time.Duration
	MaxOutput int
}

// Result is what a run that ended, or timed out, reports. Stdout and Stderr marshal as base64.
type Result struct {
	ExitCode  *int   `json:"exitCode"`
	Signal    string `json:"signal,omitempty"`
	Stdout    []byte `json:"stdout"`
	Stderr    []byte `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
}

// Run runs spec. A cancelled ctx kills the group and returns an aborted error.
func Run(ctx context.Context, spec Spec) (Result, error) {
	return Result{}, rpc.Errorf(rpc.KindUnsupported, "exec.run is not implemented")
}
