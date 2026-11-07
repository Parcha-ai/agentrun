// Package process keeps programs running across calls and connections: the daemon's process.* methods.
package process

const (
	// RingBytes is how much of each stream a process keeps: the last 8 MiB.
	RingBytes = 8 << 20
	// MaxEntries is how many processes the table holds, running or ended.
	MaxEntries = 256
	// RetainedBytes is how much output the table's rings, live and ended, hold together: 256 MiB, where 256 entries'
	// full rings would be 4 GiB. Past it, the rings of the processes that ended first are let go, then the live rings
	// are limited to an equal share of it.
	RetainedBytes = 256 << 20
	// RingFloorBytes is the least a live ring is limited to: 256 entries' two rings at the floor are 32 MiB.
	RingFloorBytes = 64 << 10
	// MaxRead is the most bytes one process.read returns: in base64, it fits a line.
	MaxRead = 512 << 10
	// MaxWaitMs bounds a read's long poll.
	MaxWaitMs = 30_000
)

// Options size a table; zero values are the defaults.
type Options struct {
	RingBytes  int
	MaxEntries int
	// RetainedBytes bounds the output every ring in the table, live or ended, holds together.
	RetainedBytes int64
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

// ListParams pages a listing: From is the Next of the page before, 0 for the first page.
type ListParams struct {
	From *int64 `json:"from,omitempty"`
}

type ListResult struct {
	Processes []Info `json:"processes"`
	Truncated bool   `json:"truncated"`
	// Next is where the page after this one starts: list again with from set to it.
	Next int64 `json:"next"`
}

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
	ID   string   `json:"id"`
	Pid  int      `json:"pid"`
	Argv []string `json:"argv"`
	// ArgvClipped says argv was cut to its first arguments to keep a listing small.
	ArgvClipped bool    `json:"argvClipped"`
	Pty         bool    `json:"pty"`
	Running     bool    `json:"running"`
	ExitCode    *int    `json:"exitCode"`
	Signal      *string `json:"signal"`
	StartedAt   int64   `json:"startedAt"`
	EndedAt     *int64  `json:"endedAt"`
}

type Empty struct{}
