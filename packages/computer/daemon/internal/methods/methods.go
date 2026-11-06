// Package methods is the daemon's method table: the Go side of src/protocol.ts.
package methods

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"runtime"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// Capabilities is what this daemon offers, as hello reports it.
var Capabilities = []string{"exec", "files", "processes"}

type HelloParams struct {
	Client string `json:"client"`
}

type HelloResult struct {
	Version      string   `json:"version"`
	OS           string   `json:"os"`
	Arch         string   `json:"arch"`
	Capabilities []string `json:"capabilities"`
}

type ExecRunParams struct {
	Argv      []string          `json:"argv"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	User      string            `json:"user,omitempty"`
	TimeoutMs *int64            `json:"timeoutMs"`
	MaxOutput *int              `json:"maxOutput,omitempty"`
}

type ExecRunResult = execrun.Result

const maxTimeoutMs = 24 * 60 * 60 * 1000

// Handlers is every method this daemon answers, with processes kept in table.
func Handlers(version string, table *process.Table) map[string]rpc.Handler {
	handlers := map[string]rpc.Handler{
		"hello": func(context.Context, json.RawMessage) (any, error) {
			return HelloResult{Version: version, OS: runtime.GOOS, Arch: runtime.GOARCH, Capabilities: Capabilities}, nil
		},
		"ping": func(context.Context, json.RawMessage) (any, error) {
			return struct{}{}, nil
		},
		"exec.run": execRun,
	}
	maps.Copy(handlers, fileHandlers())
	maps.Copy(handlers, processHandlers(table))
	return handlers
}

func execRun(ctx context.Context, raw json.RawMessage) (any, error) {
	var params ExecRunParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	if len(params.Argv) == 0 {
		return nil, rpc.Errorf(rpc.KindInvalid, "argv needs at least a program")
	}
	if params.TimeoutMs == nil || *params.TimeoutMs <= 0 || *params.TimeoutMs > maxTimeoutMs {
		return nil, rpc.Errorf(rpc.KindInvalid, "timeoutMs is required, from 1 to %d (a day)", maxTimeoutMs)
	}
	return execrun.Run(ctx, execrun.Spec{
		Argv:      params.Argv,
		Cwd:       params.Cwd,
		Env:       params.Env,
		User:      params.User,
		Timeout:   time.Duration(*params.TimeoutMs) * time.Millisecond,
		MaxOutput: params.MaxOutput,
	})
}

// strict decodes params, refusing unknown fields and wrong types as invalid params.
func strict(raw json.RawMessage, into any) error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return rpc.Errorf(rpc.KindInvalid, "invalid params: %v", err)
	}
	return nil
}
