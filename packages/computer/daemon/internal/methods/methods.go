// Package methods is the daemon's method table: the Go side of src/protocol.ts.
package methods

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"os"
	"runtime"
	"slices"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilsync"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// Groups is what this daemon offers with no display, as hello reports it: the groups of src/protocol.ts it answers.
// A display adds desktop.Groups.
var Groups = []string{"exec", "files", "processes"}

// Kind is what a computer with this daemon and no display is, as hello reports it; with one it is "desktop".
const Kind = "linux"

// Options are what a daemon has besides its process table.
type Options struct {
	// Display is the X display the screen and input methods use; nil is none.
	Display *desktop.Display
	// Deadline is init's own, which deadline.extend moves; nil is none to move.
	Deadline *lifetime.Deadline
	// SyncSocket is the Archil sync server's socket mount.sync asks; empty is archilsync.SocketPath.
	SyncSocket string
	// SyncOwner is who that socket and its folder must belong to; nil is root, and this daemon's own group.
	SyncOwner *archilsync.Owner
}

type mountSyncParams struct{}

type mountSyncResult struct {
	ExitCode int `json:"exitCode"`
}

// mountSync asks the computer's resident Archil sync server for one sync, coalesced with any in flight, and answers
// its exit code, trusting only a folder and socket of root's with this daemon's group (the tool user's). A computer
// with no Archil mount has none: not_found.
func mountSync(socket string, given *archilsync.Owner) rpc.Handler {
	if socket == "" {
		socket = archilsync.SocketPath
	}
	owner := archilsync.Owner{UID: 0, GID: os.Getegid()}
	if given != nil {
		owner = *given
	}
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		var params mountSyncParams
		if err := strict(raw, &params); err != nil {
			return nil, err
		}
		code, err := archilsync.Ask(ctx, socket, owner)
		if err != nil {
			return nil, err
		}
		return mountSyncResult{ExitCode: code}, nil
	}
}

type HelloParams struct {
	Client string `json:"client"`
}

// ProtocolVersion is the version of the protocol this daemon speaks (spec/computer), apart from its own version: the
// TypeScript side's PROTOCOL_VERSION, which a test keeps equal.
const ProtocolVersion = "0.1"

type HelloResult struct {
	Protocol string   `json:"protocol"`
	Version  string   `json:"version"`
	OS       string   `json:"os"`
	Kind     string   `json:"kind"`
	Arch     string   `json:"arch"`
	Groups   []string `json:"groups"`
	// Display is the DISPLAY a desktop's screen and input methods drive, such as ":99"; absent on any other computer.
	Display string `json:"display,omitempty"`
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

// Handlers is every method this daemon answers, with processes kept in table. hello asks the display each time, so a
// display that comes up after init (a provider may start its X server through process.start) is declared from then on,
// and one that goes is no longer declared.
func Handlers(version string, table *process.Table, options Options) map[string]rpc.Handler {
	display := options.Display
	if display == nil {
		display = desktop.New("")
	}
	handlers := map[string]rpc.Handler{
		"hello": func(context.Context, json.RawMessage) (any, error) {
			kind, groups, name := Kind, slices.Clone(Groups), ""
			if extra := display.Groups(); len(extra) > 0 {
				kind, groups, name = "desktop", append(groups, extra...), display.Name()
			}
			return HelloResult{Protocol: ProtocolVersion, Version: version, OS: runtime.GOOS, Kind: kind, Arch: runtime.GOARCH, Groups: groups, Display: name}, nil
		},
		"ping": func(context.Context, json.RawMessage) (any, error) {
			return struct{}{}, nil
		},
		"exec.run":        execRun,
		"deadline.extend": deadlineExtend(options.Deadline),
		"mount.sync":      mountSync(options.SyncSocket, options.SyncOwner),
	}
	maps.Copy(handlers, fileHandlers())
	maps.Copy(handlers, processHandlers(table))
	maps.Copy(handlers, display.Handlers())
	return handlers
}

type deadlineParams struct {
	At string `json:"at"`
}

type deadlineResult struct {
	At string `json:"at"`
}

// deadlineExtend moves init's deadline, never earlier and never past the maximum the provider gave at start.
func deadlineExtend(deadline *lifetime.Deadline) rpc.Handler {
	return func(_ context.Context, raw json.RawMessage) (any, error) {
		var params deadlineParams
		if err := strict(raw, &params); err != nil {
			return nil, err
		}
		if deadline == nil {
			return nil, rpc.Errorf(rpc.KindUnsupported, "this daemon holds no deadline: only computerd init has one")
		}
		to, err := time.Parse(time.RFC3339Nano, params.At)
		if err != nil {
			return nil, rpc.Errorf(rpc.KindInvalid, "at %q is not an ISO time, such as 2026-01-02T15:04:05.000Z", params.At)
		}
		at, err := deadline.Extend(to)
		if err != nil {
			return nil, err
		}
		return deadlineResult{At: at.UTC().Format(lifetime.ISO)}, nil
	}
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
