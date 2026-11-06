// Package methods is the daemon's method table: the Go side of src/protocol.ts.
package methods

import (
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// HelloResult answers hello.
type HelloResult struct {
	Version      string   `json:"version"`
	OS           string   `json:"os"`
	Arch         string   `json:"arch"`
	Capabilities []string `json:"capabilities"`
}

// Handlers is every method this daemon answers.
func Handlers(version string) map[string]rpc.Handler {
	return map[string]rpc.Handler{}
}
