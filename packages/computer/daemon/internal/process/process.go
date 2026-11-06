// Package process keeps programs running across calls and connections: the daemon's process.* methods.
package process

import (
	"context"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const (
	// RingBytes is how much of each stream a process keeps: the last 8 MiB.
	RingBytes = 8 << 20
	// MaxEntries is how many processes the table holds, running or ended.
	MaxEntries = 256
	// MaxRead is the most bytes one process.read returns: in base64, it fits a line.
	MaxRead = 512 << 10
	// MaxWaitMs bounds a read's long poll.
	MaxWaitMs = 30_000
)

// Options size a table; zero values are the defaults.
type Options struct {
	RingBytes  int
	MaxEntries int
}

type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type StartParams struct {
	Argv  []string          `json:"argv"`
	Cwd   string            `json:"cwd,omitempty"`
	Env   map[string]string `json:"env,omitempty"`
	User  string            `json:"user,omitempty"`
	Pty   *Size             `json:"pty,omitempty"`
	Stdin bool              `json:"stdin,omitempty"`
}

type StartResult struct {
	ID  string `json:"id"`
	Pid int    `json:"pid"`
}

type ReadParams struct {
	ID       string `json:"id"`
	Stream   string `json:"stream"`
	Offset   *int64 `json:"offset"`
	MaxBytes *int   `json:"maxBytes,omitempty"`
	WaitMs   int    `json:"waitMs,omitempty"`
}

type ReadResult struct {
	Data       []byte `json:"data"`
	NextOffset int64  `json:"nextOffset"`
	Dropped    int64  `json:"dropped"`
	Exited     bool   `json:"exited"`
}

type WriteParams struct {
	ID    string `json:"id"`
	Data  []byte `json:"data,omitempty"`
	Close bool   `json:"close,omitempty"`
}

type SignalParams struct {
	ID     string `json:"id"`
	Signal string `json:"signal"`
}

type ResizeParams struct {
	ID   string `json:"id"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type ListParams struct{}

type WaitParams struct {
	ID        string `json:"id"`
	TimeoutMs *int64 `json:"timeoutMs"`
}

type WaitResult struct {
	Running  bool    `json:"running"`
	ExitCode *int    `json:"exitCode"`
	Signal   *string `json:"signal"`
}

// Info is one process as process.list reports it. Times are milliseconds since the epoch.
type Info struct {
	ID        string   `json:"id"`
	Pid       int      `json:"pid"`
	Argv      []string `json:"argv"`
	Pty       bool     `json:"pty"`
	Running   bool     `json:"running"`
	ExitCode  *int     `json:"exitCode"`
	Signal    *string  `json:"signal"`
	StartedAt int64    `json:"startedAt"`
	EndedAt   *int64   `json:"endedAt"`
}

type Empty struct{}

// Table is every process the daemon holds, shared by all its connections.
type Table struct{}

func NewTable(opts Options) *Table { return &Table{} }

var errNotBuilt = rpc.Errorf(rpc.KindUnsupported, "processes are not built yet")

func (t *Table) Start(StartParams) (StartResult, error) { return StartResult{}, errNotBuilt }
func (t *Table) Read(context.Context, ReadParams) (ReadResult, error) {
	return ReadResult{}, errNotBuilt
}
func (t *Table) Write(context.Context, WriteParams) (Empty, error) { return Empty{}, errNotBuilt }
func (t *Table) Signal(SignalParams) (Empty, error)                { return Empty{}, errNotBuilt }
func (t *Table) Resize(ResizeParams) (Empty, error)                { return Empty{}, errNotBuilt }
func (t *Table) List(ListParams) ([]Info, error)                   { return nil, errNotBuilt }
func (t *Table) Wait(context.Context, WaitParams) (WaitResult, error) {
	return WaitResult{}, errNotBuilt
}
